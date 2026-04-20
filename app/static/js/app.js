/**
 * EVE-OS iPXE Boot Server — Frontend Application
 * Plain JS, no framework dependencies.
 */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  selectedVersion:  null,
  selectedArch:     'amd64',
  selectedHV:       'kvm',
  selectedScenario: 'baremetal',
  selectedVariant:  'generic',
  currentStep:      1,
  wizardInProgress: false,
  activeConfigId:   null,
  serverInfo:       null,
  downloadEventSource: null,
  currentConfigDbId:   null,  // ID returned after POST /api/configs
};

// ── Initialisation ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadServerInfo();
  await loadReleases();
  await loadConfigCount();

  window.addEventListener('beforeunload', () => {
    if (state.downloadEventSource) state.downloadEventSource.close();
  });
});

// ── Server info ──────────────────────────────────────────────────────────────
async function loadServerInfo() {
  try {
    const info = await api('/api/server-info');
    state.serverInfo = info;
    document.getElementById('server-host-display').textContent = info.server_host;
    // Populate the Server IP update field
    const ipInput = document.getElementById('server-ip-input');
    if (ipInput && !ipInput.dataset.dirty) ipInput.value = info.server_host;
    // Boot instructions page
    document.getElementById('instr-webui-url').innerHTML = `<code>${info.webui_base}</code>`;
    document.getElementById('instr-tftp').innerHTML     = `<code>tftp://${info.server_host}:69/</code>`;
    document.getElementById('instr-http').innerHTML     = `<code>${info.artifact_http_base}/</code>`;
    document.getElementById('instr-ipxe-url').innerHTML = `<code>${info.ipxe_boot_url}</code>`;
    // Update DHCP config examples with real IPs
    const _fillHostPort = id => {
      const el = document.getElementById(id);
      if (el) el.textContent = el.textContent
        .replaceAll('SERVER_HOST', info.server_host)
        .replaceAll('WEBUI_PORT', info.webui_port);
    };
    _fillHostPort('dhcp-config-example');
    _fillHostPort('dhcp-alt-dnsmasq');
    _fillHostPort('dhcp-alt-isc');
    // Inline IP badge in the DHCP alt section
    const altIp = document.getElementById('dhcp-alt-server-ip');
    if (altIp) altIp.textContent = info.server_host;
    const qemuEl = document.getElementById('qemu-example');
    if (qemuEl) {
      qemuEl.textContent = qemuEl.textContent
        .replaceAll('/path/to/tftp-root', `(see TFTP volume: eve-ipxe-tftp)`);
    }
  } catch (e) {
    console.warn('Could not load server info:', e);
    const el = document.getElementById('server-host-display');
    if (el) el.textContent = 'Unavailable';
  }
}

async function updateServerIP() {
  const input = document.getElementById('server-ip-input');
  const ip = input?.value?.trim();
  if (!ip) { toast('Enter an IP address', 'error'); return; }
  try {
    const res = await api('/api/server/settings', 'PUT', { server_host: ip });
    toast(res.message || 'Server IP updated', 'success');
    input.dataset.dirty = '';       // clear dirty flag so loadServerInfo can refresh it
    await loadServerInfo();         // reload endpoints table with new IP
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ── View switching ───────────────────────────────────────────────────────────

// Lightweight interval that keeps the wizard progress bar updated when the
// user navigates away from the wizard mid-download and then comes back.
let _uiRefreshInterval = null;

function _startUIRefresh() {
  if (_uiRefreshInterval) return;
  const v  = state.selectedVersion;
  const a  = state.selectedArch;
  const h  = state.selectedHV;
  const va = state.selectedVariant;
  if (!v) return;

  // Fetch once immediately so the bar un-freezes the moment the user returns
  api(`/api/artifacts/status/${encodeURIComponent(v)}/${a}/${h}/${va}`)
    .then(data => updateDownloadUI(data))
    .catch(() => {});

  _uiRefreshInterval = setInterval(async () => {
    if (!state.wizardInProgress) {
      _stopUIRefresh();
      return;
    }
    try {
      const data = await api(`/api/artifacts/status/${encodeURIComponent(v)}/${a}/${h}/${va}`);
      updateDownloadUI(data);
      if (data.status === 'ready' || data.status === 'failed') {
        _stopUIRefresh();
      }
    } catch (_) {}
  }, 1000);
}

function _stopUIRefresh() {
  if (_uiRefreshInterval) {
    clearInterval(_uiRefreshInterval);
    _uiRefreshInterval = null;
  }
}

function showView(name) {
  // Close any open SSE stream when navigating away from wizard
  if (name !== 'wizard' && state.downloadEventSource) {
    state.downloadEventSource.close();
    state.downloadEventSource = null;
  }
  // Stop the UI-refresh poll when leaving wizard; start it when returning
  if (name !== 'wizard') {
    _stopUIRefresh();
  } else if (state.wizardInProgress) {
    _startUIRefresh();
  }

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  // Clear active from both sidebar items AND mobile nav items
  document.querySelectorAll('.sidebar-item, .mobile-nav-item').forEach(s => s.classList.remove('active'));

  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('active');

  // Mark all elements with data-view matching this name as active
  document.querySelectorAll(`[data-view="${name}"]`).forEach(el => el.classList.add('active'));

  // When navigating to wizard and no download is in progress, always start
  // fresh — reset all wizard state and form fields to defaults.
  if (name === 'wizard' && !state.wizardInProgress) {
    resetWizard();
  }

  if (name === 'configs')      loadConfigs();
  if (name === 'artifacts')    loadArtifacts();
  if (name === 'dhcp')         loadDHCPStatus();
}

// ── Wizard step navigation ───────────────────────────────────────────────────
function validateStep(to) {
  // Must have a version selected before advancing past step 1
  if (to >= 2) {
    if (!state.selectedVersion) {
      toast('Please select an EVE-OS version first.', 'error');
      return false;
    }
  }
  // Must have a platform selected before advancing past step 2
  if (to >= 3) {
    if (!state.selectedArch || !state.selectedHV) {
      toast('Please select a target platform.', 'error');
      return false;
    }
  }
  if (to === 4) {
    const disk = (document.getElementById('install-disk')?.value || '').trim();
    if (!disk.startsWith('/dev/')) {
      toast('Install disk must start with /dev/ (e.g. /dev/sda)', 'error');
      document.getElementById('install-disk')?.focus();
      return false;
    }
  }
  return true;
}

function goToStep(n) {
  const current = state.currentStep || 1;
  // Validate every intermediate step when jumping forward via step indicator
  if (n > current) {
    for (let check = current + 1; check <= n; check++) {
      if (!validateStep(check)) return;
    }
  }

  if (n === 4) renderReview();

  state.currentStep = n;

  // Show/hide step content panels
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    if (el) el.style.display = i === n ? 'block' : 'none';
  }

  // Update step indicators
  document.querySelectorAll('.wizard-step').forEach(s => {
    const step = parseInt(s.dataset.step);
    s.classList.remove('active', 'completed', 'disabled');
    if (step < n)       s.classList.add('completed');
    else if (step === n) s.classList.add('active');
    else                s.classList.add('disabled');
  });

  // Move focus to the new step heading for keyboard/screen-reader navigation
  requestAnimationFrame(() => {
    const heading = document.querySelector(`#step-${n} h2, #step-${n} [class*="step-title"], #step-${n} [class*="heading"]`);
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    }
  });
}

// ── Step 1: Releases ─────────────────────────────────────────────────────────
async function loadReleases() {
  const grid     = document.getElementById('release-grid');
  const loading  = document.getElementById('releases-loading');
  const errorBox = document.getElementById('releases-error');
  const prereleases = document.getElementById('show-prereleases').checked;

  grid.style.display     = 'none';
  loading.style.display  = 'flex';
  errorBox.style.display = 'none';

  try {
    const releases = await api(`/api/releases?per_page=20&include_prereleases=${prereleases}`);
    renderReleases(releases);
    grid.style.display    = 'grid';
    loading.style.display = 'none';
  } catch (err) {
    loading.style.display  = 'none';
    errorBox.style.display = 'flex';
    document.getElementById('releases-error-msg').textContent = err.message;
  }
}

function renderReleases(releases) {
  const grid = document.getElementById('release-grid');
  grid.innerHTML = '';
  if (!releases.length) {
    grid.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No releases found.</p>';
    return;
  }
  releases.forEach(r => {
    const card = document.createElement('div');
    card.className = 'release-card';
    card.dataset.tag = r.tag_name;

    const isLts = r.tag_name.includes('lts');
    const isPre = r.prerelease;
    let badgeClass = isPre ? 'badge-prerelease' : (isLts ? 'badge-lts' : 'badge-stable');
    let badgeText  = isPre ? 'Pre-release' : (isLts ? 'LTS' : 'Stable');

    const date = new Date(r.published_at).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });

    card.innerHTML = `
      <div class="release-version">${escHtml(r.tag_name)}</div>
      <div class="release-date">${escHtml(date)}</div>
      <div><span class="release-badge ${badgeClass}">${badgeText}</span></div>
    `;
    card.addEventListener('click', () => selectRelease(r.tag_name, card));
    grid.appendChild(card);
  });
}

function selectRelease(tag, cardEl) {
  document.querySelectorAll('.release-card').forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');
  state.selectedVersion = tag;
  document.getElementById('step1-next').disabled = false;
  applyVersionConstraints(tag);
}

/**
 * The EVE-OS 'k' (no-KVM) HV mode was first introduced in EVE 16.x.
 * Disable it and warn when an older version is selected.
 */
function eveMajorVersion(tag) {
  // Tags look like "16.12.0", "v16.12.0", "eve-16.12.0", "16.12.0-lts", etc.
  const m = tag.match(/(\d+)\.\d/);
  return m ? parseInt(m[1], 10) : 0;
}

function applyVersionConstraints(tag) {
  const major = eveMajorVersion(tag);
  const kTile  = document.getElementById('hv-k-tile');
  const kNote  = document.getElementById('hv-k-version-note');
  const kSupported = major >= 16;

  if (!kSupported) {
    kTile.classList.add('disabled');
    kTile.title = 'k mode requires EVE ≥ 16.x';
    if (kNote) kNote.style.display = 'flex';
    if (state.selectedHV === 'k') selectHV('kvm');
  } else {
    // Only re-enable if arch also allows it (amd64 only)
    if (state.selectedArch !== 'arm64') {
      kTile.classList.remove('disabled');
      kTile.title = '';
    }
    if (kNote) kNote.style.display = 'none';
  }
}

// ── Step 2: Platform selectors ───────────────────────────────────────────────
function selectArch(arch) {
  state.selectedArch = arch;
  document.querySelectorAll('[data-arch]').forEach(t =>
    t.classList.toggle('selected', t.dataset.arch === arch));

  // k mode only for amd64
  const kTile = document.getElementById('hv-k-tile');
  if (arch === 'arm64') {
    kTile.classList.add('disabled');
    kTile.title = 'k mode is amd64-only';
    if (state.selectedHV === 'k') { state.selectedHV = 'kvm'; selectHV('kvm'); }

    // Nvidia variants only for arm64
    document.getElementById('variant-jp5').style.display = '';
    document.getElementById('variant-jp6').style.display = '';
  } else {
    // Only re-enable k if the selected version also supports it
    if (eveMajorVersion(state.selectedVersion || '') >= 16) {
      kTile.classList.remove('disabled');
      kTile.title = '';
    }
    document.getElementById('variant-jp5').style.display = 'none';
    document.getElementById('variant-jp6').style.display = 'none';
    if (['nvidia-jp5','nvidia-jp6'].includes(state.selectedVariant)) {
      selectVariant('generic');
    }
  }

  // Scenario tiles: edge is arm64-only; baremetal/vm are amd64-only
  const edgeTile   = document.getElementById('scenario-edge-tile');
  const bmetalTile = document.querySelector('[data-scenario="baremetal"]');
  const vmTile     = document.querySelector('[data-scenario="vm"]');
  if (arch === 'arm64') {
    if (edgeTile)   edgeTile.style.display   = '';
    if (bmetalTile) bmetalTile.style.display  = 'none';
    if (vmTile)     vmTile.style.display      = 'none';
    selectScenario('edge');
  } else {
    if (edgeTile)   edgeTile.style.display   = 'none';
    if (bmetalTile) bmetalTile.style.display  = '';
    if (vmTile)     vmTile.style.display      = '';
    if (state.selectedScenario === 'edge') selectScenario('baremetal');
  }

  updateNvidiaWarning();
}

function selectHV(hv) {
  // Respect the disabled state — covers both ARM64 and version-gate cases
  const tile = document.querySelector(`[data-hv="${hv}"]`);
  if (tile && tile.classList.contains('disabled')) return;
  state.selectedHV = hv;
  document.querySelectorAll('[data-hv]').forEach(t =>
    t.classList.toggle('selected', t.dataset.hv === hv));
}

function selectScenario(s) {
  state.selectedScenario = s;
  document.querySelectorAll('[data-scenario]').forEach(t =>
    t.classList.toggle('selected', t.dataset.scenario === s));

  const diskEl    = document.getElementById('install-disk');
  const diskHint  = document.querySelector('#install-disk + .field-hint');

  if (s === 'vm') {
    // VirtIO block device — the default for QEMU/KVM guests.
    // Use /dev/hda for virtual SATA, /dev/sda for virtual SCSI.
    if (diskEl && (diskEl.value === '/dev/sda' || diskEl.value === '/dev/vda')) {
      diskEl.value = '/dev/vda';
    }
    if (diskHint) diskHint.textContent =
      'VirtIO block device (QEMU default). Use /dev/sda for SATA or SCSI virtual drives.';
  } else {
    if (diskEl && diskEl.value === '/dev/vda') {
      diskEl.value = '/dev/sda';
    }
    if (diskHint) diskHint.textContent =
      'Primary disk for EVE OS installation (e.g. /dev/sda, /dev/nvme0n1, /dev/mmcblk0)';
  }

  // Edge scenario → suggest ARM64 serial console defaults
  if (s === 'edge' && state.selectedArch === 'amd64') {
    const consoleEl = document.getElementById('console');
    if (consoleEl && consoleEl.value === 'tty0 ttyS0,115200n8') {
      consoleEl.value = 'ttyS0,115200n8 ttyAMA0,115200n8';
    }
  }
}

function selectVariant(v) {
  state.selectedVariant = v;
  document.querySelectorAll('[data-variant]').forEach(t =>
    t.classList.toggle('selected', t.dataset.variant === v));
  updateNvidiaWarning();
}

function updateNvidiaWarning() {
  const show = ['nvidia-jp5','nvidia-jp6'].includes(state.selectedVariant);
  document.getElementById('nvidia-no-net-warning').style.display = show ? 'flex' : 'none';
}

// ── Step 4: Review & Deploy ───────────────────────────────────────────────────
function renderReview() {
  const params = collectParams();
  const content = document.getElementById('review-content');
  const s = state.serverInfo;
  const base = s
    ? `http://${s.server_host}:${s.http_port}/artifacts/${params.eve_version}/${params.architecture}.${params.hv_mode}.${params.variant}`
    : '…';

  content.innerHTML = `
    <table class="instructions-table">
      <thead><tr><th>Parameter</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Config name</td>   <td>${escHtml(params.name)}</td></tr>
        <tr><td>EVE version</td>   <td>${escHtml(params.eve_version)}</td></tr>
        <tr><td>Architecture</td>  <td>${escHtml(params.architecture)}</td></tr>
        <tr><td>HV mode</td>       <td>${escHtml(params.hv_mode)}</td></tr>
        <tr><td>Variant</td>       <td>${escHtml(params.variant)}</td></tr>
        <tr><td>Scenario</td>      <td>${escHtml(params.scenario)}</td></tr>
        <tr><td>Install disk</td>  <td><code>${escHtml(params.install_disk)}</code></td></tr>
        ${params.persist_disk ? `<tr><td>Persist disk</td><td><code>${escHtml(params.persist_disk)}</code></td></tr>` : ''}
        ${params.controller_url ? `<tr><td>Controller</td><td><code>${escHtml(params.controller_url)}</code></td></tr>` : ''}
        <tr><td>Reboot after</td>  <td>${params.reboot_after_install ? '✓ Yes' : '✗ No'}</td></tr>
        <tr><td>Nuke disk</td>     <td>${params.nuke_disk ? '⚠ Yes' : 'No'}</td></tr>
        <tr><td>Artifact URL</td>  <td><code style="font-size:11px;">${escHtml(base)}/</code></td></tr>
      </tbody>
    </table>`;
}

function collectParams() {
  return {
    name:                 val('cfg-name')     || 'Default Config',
    eve_version:          state.selectedVersion,
    architecture:         state.selectedArch,
    hv_mode:              state.selectedHV,
    variant:              state.selectedVariant,
    scenario:             state.selectedScenario,
    install_disk:         val('install-disk') || '/dev/sda',
    persist_disk:         val('persist-disk') || null,
    controller_url:       val('controller-url') || null,
    soft_serial:          val('soft-serial') || null,
    reboot_after_install: checked('reboot-after'),
    nuke_disk:            checked('nuke-disk'),
    pause_before_install: checked('pause-before'),
    console:              val('console') || 'tty0 ttyS0,115200n8',
    extra_cmdline:        val('extra-cmdline') || null,
  };
}

async function createAndDownload() {
  const params = collectParams();

  if (!params.eve_version) { toast('No EVE version selected.', 'error'); return; }
  if (!params.install_disk.startsWith('/dev/')) {
    toast('Install disk must start with /dev/', 'error'); return;
  }

  state.wizardInProgress = true;

  const btn = document.getElementById('create-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Creating…';

  try {
    // 1. Save config to DB
    let cfg;
    if (state.currentConfigDbId) {
      cfg = await api(`/api/configs/${state.currentConfigDbId}`, 'PUT', params);
    } else {
      cfg = await api('/api/configs', 'POST', params);
      state.currentConfigDbId = cfg.id;
    }

    toast('Configuration saved.', 'success');

    // 2. Trigger artifact download
    document.getElementById('download-section').style.display = 'block';
    btn.innerHTML = '⬇ Downloading…';

    await api(`/api/artifacts/download?eve_version=${encodeURIComponent(params.eve_version)}&architecture=${params.architecture}&hv_mode=${params.hv_mode}&variant=${params.variant}`, 'POST');

    // 3. Stream progress
    await streamDownloadProgress(params, cfg.id);
    state.wizardInProgress = false;

  } catch (err) {
    state.wizardInProgress = false;
    toast('Error: ' + err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = '⬇ Download Artifacts &amp; Activate';
  }
}

async function streamDownloadProgress(params, configId) {
  return new Promise((resolve, reject) => {
    if (state.downloadEventSource) state.downloadEventSource.close();

    const url = `/api/artifacts/stream/${encodeURIComponent(params.eve_version)}/${params.architecture}/${params.hv_mode}/${params.variant}`;
    const es = new EventSource(url);
    state.downloadEventSource = es;

    // Guard against double-resolution: 'done' handler and onerror may both fire
    // when the server closes the SSE connection cleanly (browser fires onerror on close).
    let settled = false;
    function settle(fn, arg) {
      if (settled) return;
      settled = true;
      es.close();
      state.downloadEventSource = null;
      fn(arg);
    }

    es.addEventListener('progress', e => {
      const data = JSON.parse(e.data);
      updateDownloadUI(data);
    });

    es.addEventListener('done', async e => {
      const data = JSON.parse(e.data);
      updateDownloadUI(data);

      if (data.status === 'ready') {
        try {
          await api(`/api/configs/${configId}/activate`, 'POST');
          await loadScriptPreview(configId);
          toast('Configuration activated!', 'success');
          document.getElementById('create-btn').style.display = 'none';
          document.getElementById('dl-script-btn').style.display = '';
          document.getElementById('boot-btn').style.display = '';
          await loadConfigCount();
          settle(resolve, undefined);
        } catch (err) {
          toast('Activation error: ' + err.message, 'error');
          settle(reject, err);
        }
      } else {
        const msg = data.error || 'Download failed';
        toast('Download failed: ' + msg, 'error');
        document.getElementById('create-btn').disabled = false;
        document.getElementById('create-btn').innerHTML = '⬇ Retry Download';
        settle(reject, new Error(msg));
      }
    });

    es.onerror = () => {
      if (settled) return;  // 'done' already handled it — connection closed cleanly
      es.close();
      // SSE failed mid-stream — fall back to polling
      pollUntilReady(params, configId,
        (v) => settle(resolve, v),
        (e) => settle(reject, e),
      );
    };
  });
}

function updateDownloadUI(data) {
  const status  = data.status || 'pending';
  const pct     = data.progress ?? 0;
  const labels  = {
    downloading: 'Downloading installer artifact…',
    extracting:  'Extracting kernel and grub files…',
    ready:       'Complete',
    failed:      'Failed: ' + (data.error || 'unknown error'),
    pending:     'Queued…',
  };

  document.getElementById('download-label').textContent      = labels[status] || status;
  document.getElementById('download-pct').textContent        = pct + '%';
  document.getElementById('download-fill').style.width       = pct + '%';
  document.getElementById('download-status-text').textContent = status;

  if (data.bytes_downloaded && data.bytes_total) {
    document.getElementById('download-bytes').textContent =
      `${humanSize(data.bytes_downloaded)} / ${humanSize(data.bytes_total)}`;
  }

  if (status === 'ready') {
    document.getElementById('download-fill')?.classList.add('complete');
  }
}

async function pollUntilReady(params, configId, resolve, reject) {
  let attempts = 0;
  let consecutiveErrors = 0;
  const maxAttempts = 600;

  const poll = setInterval(async () => {
    attempts++;
    try {
      const data = await api(`/api/artifacts/status/${encodeURIComponent(params.eve_version)}/${params.architecture}/${params.hv_mode}/${params.variant}`);
      consecutiveErrors = 0;
      updateDownloadUI(data);

      if (data.status === 'ready') {
        clearInterval(poll);
        try {
          await api(`/api/configs/${configId}/activate`, 'POST');
          await loadScriptPreview(configId);
          toast('Configuration activated!', 'success');
          document.getElementById('create-btn').style.display = 'none';
          document.getElementById('dl-script-btn').style.display = '';
          document.getElementById('boot-btn').style.display = '';
          await loadConfigCount();
          state.wizardInProgress = false;
          resolve();
        } catch (err) {
          clearInterval(poll);
          state.wizardInProgress = false;
          reject(err);
        }
      } else if (data.status === 'failed' || attempts >= maxAttempts) {
        clearInterval(poll);
        state.wizardInProgress = false;
        const msg = data.error || (attempts >= maxAttempts ? 'Timed out waiting for download' : 'Download failed');
        toast('Download failed: ' + msg, 'error');
        document.getElementById('create-btn').disabled = false;
        document.getElementById('create-btn').innerHTML = '⬇ Retry Download';
        reject(new Error(msg));
      }
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        clearInterval(poll);
        state.wizardInProgress = false;
        toast('Lost contact with server.', 'error');
        reject(new Error('Server unreachable'));
      }
    }
  }, 1000);
}

async function loadScriptPreview(configId) {
  try {
    const data = await api(`/api/configs/${configId}/script`);
    const script = data.script;
    document.getElementById('script-preview-section').style.display = 'block';
    document.getElementById('script-preview-content').textContent = script;
    if (state.serverInfo) {
      document.getElementById('script-url-label').textContent =
        `http://${state.serverInfo.server_host}:${state.serverInfo.webui_port}/ipxe/boot.ipxe`;
    }
    const badge = document.getElementById('boot-mode-badge');
    if (badge && data.script) {
      badge.textContent = data.script.includes('chain --replace') || data.script.includes('chain ${url}')
        ? 'UEFI grub-chain (v12+)'
        : 'Direct kernel (pre-v12)';
    }
  } catch (e) {
    console.warn('Could not load script preview:', e);
  }
}

function downloadScript() {
  if (!state.serverInfo) return;
  const url = `http://${state.serverInfo.server_host}:${state.serverInfo.webui_port}/ipxe/boot.ipxe`;
  const a = document.createElement('a');
  a.href = url;
  a.download = 'boot.ipxe';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function copyScript() {
  const pre = document.getElementById('script-preview-content');
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent)
    .then(() => toast('Script copied to clipboard', 'success'))
    .catch(() => toast('Copy failed', 'error'));
}

// ── Configs view ─────────────────────────────────────────────────────────────
async function loadConfigs() {
  const list = document.getElementById('configs-list');
  list.innerHTML = '<div class="flex items-center gap-3" style="padding:20px; color:var(--text-muted); font-size:13px;"><div class="spinner"></div> Loading…</div>';
  try {
    const configs = await api('/api/configs');
    renderConfigs(configs);
    document.getElementById('config-count').textContent = configs.length;
    const mobileCount = document.getElementById('config-count-mobile');
    if (mobileCount) mobileCount.textContent = configs.length;
  } catch (e) {
    list.innerHTML = `<div class="info-box error"><span class="info-box-icon">⚠</span><div class="info-box-content"><div class="info-box-title">Error</div><div class="info-box-body">${escHtml(e.message)}</div></div></div>`;
  }
}

async function loadConfigCount() {
  try {
    const configs = await api('/api/configs');
    document.getElementById('config-count').textContent = configs.length;
    const mobileCount = document.getElementById('config-count-mobile');
    if (mobileCount) mobileCount.textContent = configs.length;
  } catch (_) {}
}

function renderConfigs(configs) {
  const list = document.getElementById('configs-list');
  if (!configs || configs.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:2rem;">No saved configurations yet.</p>';
    return;
  }
  list.innerHTML = '';
  configs.forEach(c => {
    const item = document.createElement('div');
    item.className = 'config-item' + (c.is_active ? ' active' : '');

    const meta = document.createElement('div');
    meta.className = 'config-item-meta';

    const titleRow = document.createElement('div');
    titleRow.className = 'config-item-title';
    const titleText = document.createTextNode(c.name + ' ');
    titleRow.appendChild(titleText);
    if (c.is_active) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-active';
      badge.textContent = 'ACTIVE';
      titleRow.appendChild(badge);
    }

    const sub = document.createElement('div');
    sub.className = 'config-item-sub';
    sub.textContent = `${c.eve_version} · ${c.architecture} · ${c.hv_mode} · ${c.variant}`;

    const diskInfo = document.createElement('div');
    diskInfo.className = 'config-item-sub';
    diskInfo.textContent = c.install_disk + (c.controller_url ? ' → ' + c.controller_url : '');

    const statusBadge = document.createElement('span');
    const statusClassMap = {
      ready: 'badge-ready',
      downloading: 'badge-downloading',
      extracting: 'badge-downloading',
      failed: 'badge-failed',
      pending: 'badge-pending',
    };
    statusBadge.className = `badge ${statusClassMap[c.download_status] || 'badge-pending'}`;
    statusBadge.textContent = c.download_status;

    meta.appendChild(titleRow);
    meta.appendChild(sub);
    meta.appendChild(diskInfo);
    meta.appendChild(statusBadge);

    const actions = document.createElement('div');
    actions.className = 'config-item-actions';

    if (!c.is_active && c.download_status === 'ready') {
      const activateBtn = document.createElement('button');
      activateBtn.className = 'btn btn-primary btn-sm';
      activateBtn.textContent = 'Activate';
      activateBtn.addEventListener('click', () => activateConfig(c.id));
      actions.appendChild(activateBtn);
    }

    if (c.is_active) {
      const deactivateBtn = document.createElement('button');
      deactivateBtn.className = 'btn btn-secondary btn-sm';
      deactivateBtn.textContent = 'Deactivate';
      deactivateBtn.addEventListener('click', () => deactivateConfig(c.id));
      actions.appendChild(deactivateBtn);
    }

    if (!['ready', 'downloading', 'extracting'].includes(c.download_status)) {
      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn btn-secondary btn-sm';
      dlBtn.textContent = '↻ Download';
      dlBtn.addEventListener('click', () => redownload(c.id, c.eve_version, c.architecture, c.hv_mode, c.variant));
      actions.appendChild(dlBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteConfig(c.id, c.name));
    actions.appendChild(deleteBtn);

    item.appendChild(meta);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

async function activateConfig(id) {
  try {
    await api(`/api/configs/${id}/activate`, 'POST');
    toast('Configuration activated', 'success');
    await loadConfigs();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function deactivateConfig(id) {
  if (!confirm('Deactivate this configuration? PXE clients will no longer receive a boot script.')) return;
  try {
    await api(`/api/configs/${id}/deactivate`, 'POST');
    toast('Configuration deactivated — boot.ipxe removed from TFTP', 'success');
    await loadConfigs();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function deleteConfig(id) {
  if (!confirm('Delete this configuration?')) return;
  try {
    await api(`/api/configs/${id}`, 'DELETE');
    toast('Configuration deleted', 'success');
    await loadConfigs();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function redownload(configId, version, arch, hv, variant) {
  let consecutiveErrors = 0;
  let poll;

  try {
    await api(`/api/artifacts/download?eve_version=${encodeURIComponent(version)}&architecture=${arch}&hv_mode=${hv}&variant=${variant}`, 'POST');
  } catch (e) {
    toast('Could not start re-download: ' + e.message, 'error');
    return;
  }

  poll = setInterval(async () => {
    try {
      const data = await api(`/api/artifacts/status/${encodeURIComponent(version)}/${arch}/${hv}/${variant}`);
      consecutiveErrors = 0;
      if (data.status === 'ready') {
        clearInterval(poll);
        toast('Artifacts ready — reactivating config…', 'success');
        try {
          await api(`/api/configs/${configId}/activate`, 'POST');
          await loadConfigs();
          toast('Config reactivated.', 'success');
        } catch (e) {
          toast('Reactivation failed: ' + e.message, 'error');
        }
      } else if (data.status === 'failed') {
        clearInterval(poll);
        toast('Re-download failed: ' + (data.error || 'unknown error'), 'error');
        await loadConfigs();
      }
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        clearInterval(poll);
        toast('Lost contact with server during re-download.', 'error');
      }
    }
  }, 2000);
}

// ── Artifacts view ───────────────────────────────────────────────────────────
async function loadArtifacts() {
  const container = document.getElementById('artifacts-list');
  container.innerHTML = '<div class="flex items-center gap-3" style="padding:20px; color:var(--text-muted); font-size:13px;"><div class="spinner"></div> Loading…</div>';
  try {
    const { artifacts } = await api('/api/artifacts/list');
    if (!artifacts.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📦</div>
          <h3>No cached artifacts</h3>
          <p>Create a configuration and download artifacts to get started.</p>
        </div>`;
      return;
    }
    container.innerHTML = '';
    artifacts.forEach(a => {
      const item = document.createElement('div');
      item.className = 'config-item';
      item.style.marginBottom = '10px';

      const info = document.createElement('div');
      info.className = 'config-item-info';

      const nameRow = document.createElement('div');
      nameRow.className = 'config-item-name';
      nameRow.textContent = `${a.version} / ${a.combo} `;
      const statusSpan = document.createElement('span');
      statusSpan.className = `status-pill status-${a.status}`;
      statusSpan.textContent = a.status;
      nameRow.appendChild(statusSpan);

      const metaRow = document.createElement('div');
      metaRow.className = 'config-item-meta';
      metaRow.textContent = `Boot mode: ${a.boot_mode} · ${humanSize(a.size_bytes)} · ${a.files.length} files`;

      info.appendChild(nameRow);
      info.appendChild(metaRow);

      const actions = document.createElement('div');
      actions.className = 'config-item-actions';

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteArtifacts(a.version, a.combo));
      actions.appendChild(delBtn);

      item.appendChild(info);
      item.appendChild(actions);
      container.appendChild(item);
    });
  } catch (e) {
    container.innerHTML = `<div class="info-box error"><span class="info-box-icon">⚠</span><div class="info-box-content"><div class="info-box-title">Error</div><div class="info-box-body">${escHtml(e.message)}</div></div></div>`;
  }
}

async function deleteArtifacts(version, combo) {
  if (!confirm(`Delete cached artifacts for ${version}/${combo}?`)) return;
  const parts = combo.split('.');  // arch.hv.variant
  try {
    await api(`/api/artifacts/${encodeURIComponent(version)}/${parts[0]}/${parts[1]}/${parts[2]}`, 'DELETE');
    toast('Artifacts deleted', 'success');
    await loadArtifacts();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ── Wizard reset ─────────────────────────────────────────────────────────────
function resetWizard() {
  // Close any in-flight SSE stream and UI-refresh poll
  if (state.downloadEventSource) {
    state.downloadEventSource.close();
    state.downloadEventSource = null;
  }
  _stopUIRefresh();

  // Reset all state fields
  state.currentConfigDbId = null;
  state.wizardInProgress  = false;
  state.selectedVersion   = null;
  state.selectedArch      = 'amd64';
  state.selectedHV        = 'kvm';
  state.selectedScenario  = 'baremetal';
  state.selectedVariant   = 'generic';
  state.currentStep       = 1;

  // Clear visual tile selections so display matches state
  document.querySelectorAll('.option-tile').forEach(t => t.classList.remove('selected'));
  // Reselect the default tiles (amd64 + kvm + baremetal + generic)
  const defaultArch = document.querySelector('.option-tile[data-arch="amd64"]');
  const defaultHv   = document.querySelector('.option-tile[data-hv="kvm"]');
  if (defaultArch) defaultArch.classList.add('selected');
  if (defaultHv)   defaultHv.classList.add('selected');
  // NVIDIA variants are arm64-only — hide them when resetting to amd64 default
  document.getElementById('variant-jp5').style.display = 'none';
  document.getElementById('variant-jp6').style.display = 'none';

  // Scenario tiles: restore amd64 default (hide edge, show baremetal/vm)
  const edgeTile = document.getElementById('scenario-edge-tile');
  if (edgeTile) edgeTile.style.display = 'none';
  const bmetalTile = document.querySelector('[data-scenario="baremetal"]');
  const vmTile     = document.querySelector('[data-scenario="vm"]');
  if (bmetalTile) bmetalTile.style.display = '';
  if (vmTile)     vmTile.style.display     = '';
  // Reselect the default scenario tile
  const defaultScenario = document.querySelector('.option-tile[data-scenario="baremetal"]');
  if (defaultScenario) defaultScenario.classList.add('selected');

  // Clear selected release card
  document.querySelectorAll('.release-card').forEach(c => c.classList.remove('selected'));

  // Reset all form fields to their defaults
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
  setVal('cfg-name',       '');
  setVal('install-disk',   '/dev/sda');
  setVal('persist-disk',   '');
  setVal('controller-url', '');
  setVal('soft-serial',    '');
  setVal('console',        'tty0 ttyS0,115200n8');
  setVal('extra-cmdline',  '');
  setChk('reboot-after',   true);
  setChk('nuke-disk',      false);
  setChk('pause-before',   false);

  // Reset script preview section
  document.getElementById('script-preview-section') &&
    (document.getElementById('script-preview-section').style.display = 'none');

  // Reset download section UI
  document.getElementById('step1-next') && (document.getElementById('step1-next').disabled = true);
  document.getElementById('download-section') && (document.getElementById('download-section').style.display = 'none');
  const createBtn = document.getElementById('create-btn');
  if (createBtn) {
    createBtn.style.display = '';
    createBtn.disabled = false;
    createBtn.innerHTML = '⬇ Download Artifacts &amp; Activate';
  }
  document.getElementById('dl-script-btn') && (document.getElementById('dl-script-btn').style.display = 'none');
  document.getElementById('boot-btn') && (document.getElementById('boot-btn').style.display = 'none');
  goToStep(1);
}

// ── Utilities ────────────────────────────────────────────────────────────────
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    const detail = data?.detail;
    let msg;
    if (typeof detail === 'string') {
      msg = detail;
    } else if (Array.isArray(detail)) {
      // Pydantic validation errors — extract the human-readable msg from each item
      msg = detail.map(e => {
        const field = e.loc ? e.loc.filter(l => l !== 'body').join('.') : '';
        return field ? `${field}: ${e.msg}` : e.msg;
      }).join('\n');
    } else {
      msg = `HTTP ${res.status}`;
    }
    throw new Error(msg);
  }
  return data;
}

function val(id)     { return document.getElementById(id)?.value?.trim() || ''; }
function checked(id) { return document.getElementById(id)?.checked || false; }

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function toast(msg, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${escHtml(msg)}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ── DHCP Server management ───────────────────────────────────────────────────
async function loadDHCPStatus() {
  try {
    const data = await api('/api/dhcp/status');
    _renderDHCPStatus(data);
    // Always merge with server-IP-derived defaults: ensures the pool is on
    // the correct subnet even when loading saved settings that may be stale
    // or were created on a different host/network.
    const settings = _mergeWithInferred(data.settings || {}, state.serverInfo?.server_host);
    _populateDHCPSettings(settings);
  } catch (e) {
    document.getElementById('dhcp-status-label').textContent = 'Error loading status';
    document.getElementById('dhcp-status-sub').textContent   = e.message;
  }
}

// ── Subnet utilities ─────────────────────────────────────────────────────────

const _ipToInt = ip => ip.split('.').reduce((n, o) => ((n << 8) | parseInt(o, 10)) >>> 0, 0);
const _intToIp = n  => [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join('.');
const _isValidIp = ip => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(o => +o <= 255);
const _prefixToMask = p => { const b=(0xFFFFFFFF<<(32-p))>>>0; return _intToIp(b); };
const _prefixToMaskInt = p => (0xFFFFFFFF<<(32-p))>>>0;

/** Full subnet info for a given anchor IP (gateway) and CIDR prefix. */
function _subnetInfo(anchorIp, prefix) {
  if (!_isValidIp(anchorIp) || prefix < 1 || prefix > 30) return null;
  const maskInt   = _prefixToMaskInt(prefix);
  const netInt    = _ipToInt(anchorIp) & maskInt;
  const bcastInt  = (netInt | (~maskInt >>> 0)) >>> 0;
  const usable    = Math.max(0, bcastInt - netInt - 1);
  return {
    mask:      _intToIp(maskInt),
    network:   _intToIp(netInt),
    broadcast: _intToIp(bcastInt),
    netInt, bcastInt, usable,
  };
}

/**
 * Return a sensible DHCP pool for the given anchor IP and CIDR prefix.
 * Pool starts at offset 100 from the network address (leaving room for
 * static assignments) and covers up to 150 IPs.  Scaled down for small
 * subnets so the pool always fits within the usable space.
 */
function _defaultPool(anchorIp, prefix) {
  const info = _subnetInfo(anchorIp, prefix);
  if (!info) return null;
  const { netInt, bcastInt, usable } = info;
  if (usable < 2) return null;
  // /29 and smaller — use all available hosts
  if (usable <= 6)
    return { start: _intToIp(netInt + 1), end: _intToIp(bcastInt - 1) };
  // All other sizes: start at offset 100 (or ~40% for small subnets),
  // pool up to 150 IPs.
  const startOff = usable >= 200 ? 100 : Math.max(5, Math.floor(usable * 0.4));
  const poolSize = Math.min(150, usable - startOff - 1);
  return {
    start: _intToIp(netInt + startOff),
    end:   _intToIp(netInt + startOff + Math.max(1, poolSize)),
  };
}

/**
 * Best available subnet anchor: gateway IP if valid, else pool start IP.
 * This lets all subnet calculations work even when no gateway is configured.
 */
function _subnetAnchor() {
  const gw      = document.getElementById('dhcp-gateway')?.value?.trim();
  const startIp = document.getElementById('dhcp-range-start')?.value?.trim();
  if (gw && _isValidIp(gw))           return gw;
  if (startIp && _isValidIp(startIp)) return startIp;
  return null;
}

/** Update the calculated subnet info panel. Falls back to pool-start when no gateway is set. */
function _refreshSubnetPanel() {
  const anchor = _subnetAnchor();
  const prefix = parseInt(document.getElementById('dhcp-prefix')?.value || '24', 10);
  const panel  = document.getElementById('dhcp-subnet-info');
  if (!anchor) { if (panel) panel.style.display = 'none'; return; }

  const info = _subnetInfo(anchor, prefix);
  if (!info || !panel) return;

  const startIp = document.getElementById('dhcp-range-start')?.value?.trim();
  const endIp   = document.getElementById('dhcp-range-end')?.value?.trim();
  let poolSize  = '—';
  if (startIp && endIp && _isValidIp(startIp) && _isValidIp(endIp)) {
    const diff = _ipToInt(endIp) - _ipToInt(startIp) + 1;
    poolSize = diff > 0 ? diff.toLocaleString() : '⚠ invalid';
  }

  document.getElementById('dhcp-calc-mask').textContent      = info.mask;
  document.getElementById('dhcp-calc-network').textContent   = `${info.network}/${prefix}`;
  document.getElementById('dhcp-calc-broadcast').textContent = info.broadcast;
  document.getElementById('dhcp-calc-usable').textContent    = info.usable.toLocaleString();
  document.getElementById('dhcp-calc-pool').textContent      = poolSize;
  panel.style.display = '';
}

/** Validate range start/end are inside the current subnet. Returns true if OK. */
function _validateDHCPRange() {
  const warnEl  = document.getElementById('dhcp-range-warning');
  const startIp = document.getElementById('dhcp-range-start')?.value?.trim();
  const endIp   = document.getElementById('dhcp-range-end')?.value?.trim();
  const anchor  = _subnetAnchor();
  const prefix  = parseInt(document.getElementById('dhcp-prefix')?.value || '24', 10);
  if (!warnEl) return true;

  const warn = msg => { warnEl.textContent = '⚠ ' + msg; warnEl.style.display = ''; return false; };
  const ok   = ()  => { warnEl.style.display = 'none'; return true; };

  if (!startIp || !endIp) return ok();
  if (!_isValidIp(startIp)) return warn('Invalid start IP.');
  if (!_isValidIp(endIp))   return warn('Invalid end IP.');

  const startInt = _ipToInt(startIp), endInt = _ipToInt(endIp);
  if (startInt >= endInt) return warn('Start IP must be less than end IP.');

  if (anchor) {
    const info = _subnetInfo(anchor, prefix);
    if (info) {
      if ((startInt & _prefixToMaskInt(prefix)) !== info.netInt)
        return warn(`Start IP ${startIp} is outside subnet ${info.network}/${prefix}.`);
      if ((endInt   & _prefixToMaskInt(prefix)) !== info.netInt)
        return warn(`End IP ${endIp} is outside subnet ${info.network}/${prefix}.`);
      if (startInt <= info.netInt)
        return warn(`Start IP must be greater than the network address (${info.network}).`);
      if (endInt >= info.bcastInt)
        return warn(`End IP must be less than the broadcast address (${info.broadcast}).`);
    }
  }
  return ok();
}

/**
 * Called when gateway IP or prefix changes.
 * Recalculates pool start/end based on the new subnet definition.
 * Falls back to pool-start as anchor when no gateway is set.
 */
function onDHCPNetworkChange() {
  const anchor = _subnetAnchor();
  const prefix = parseInt(document.getElementById('dhcp-prefix')?.value || '24', 10);
  if (anchor) {
    const pool = _defaultPool(anchor, prefix);
    if (pool) {
      document.getElementById('dhcp-range-start').value = pool.start;
      document.getElementById('dhcp-range-end').value   = pool.end;
    }
  }
  _validateDHCPRange();
  _refreshSubnetPanel();
}

/** Called when pool start/end are edited manually — re-validate and refresh pool count. */
function onDHCPRangeChange() {
  _validateDHCPRange();
  _refreshSubnetPanel();
}

/** Derive sensible defaults anchored to the server's own IP and /24 subnet. */
function _inferFromServerIP(serverIp) {
  if (!serverIp || !_isValidIp(serverIp) || serverIp === '127.0.0.1') return null;
  const p    = serverIp.split('.');
  const gwIp = `${p[0]}.${p[1]}.${p[2]}.1`;  // gateway = .1 of same /24
  const pool = _defaultPool(gwIp, 24);
  if (!pool) return null;
  return { gateway: gwIp, prefix_length: 24, range_start: pool.start, range_end: pool.end, lease_time: '12h' };
}

/**
 * Merge saved settings with server-IP-derived defaults.
 * Guarantees the DHCP pool is always on the same subnet as the server so
 * PXE clients can reach the TFTP/HTTP server without routing.
 *
 * Rules applied in order:
 *  1. Gateway:    use saved if valid IP; otherwise use inferred (.1 of server /24).
 *  2. Pool range: keep saved if it is on the same subnet as the server IP;
 *                 otherwise reset to inferred (stale defaults from another host).
 *  3. Everything else (interface, lease_time, dns, server_host): keep saved.
 */
function _mergeWithInferred(saved, serverIp) {
  const inferred = _inferFromServerIP(serverIp);
  if (!inferred) return saved;

  // 1. Gateway
  const gateway = (saved.gateway && _isValidIp(saved.gateway))
    ? saved.gateway
    : inferred.gateway;

  // 2. Pool — reset if saved pool is on a different subnet than the server
  let range_start = saved.range_start;
  let range_end   = saved.range_end;
  const prefix    = saved.prefix_length || inferred.prefix_length;
  if (serverIp && _isValidIp(serverIp) && range_start && _isValidIp(range_start)) {
    const maskInt   = _prefixToMaskInt(prefix);
    const serverNet = _ipToInt(serverIp)    & maskInt;
    const poolNet   = _ipToInt(range_start) & maskInt;
    if (serverNet !== poolNet) {
      range_start = inferred.range_start;
      range_end   = inferred.range_end;
    }
  } else if (!range_start) {
    range_start = inferred.range_start;
    range_end   = inferred.range_end;
  }

  return { ...saved, gateway, prefix_length: prefix, range_start, range_end };
}

function _renderDHCPStatus(data) {
  const dot      = document.getElementById('dhcp-status-dot');
  const label    = document.getElementById('dhcp-status-label');
  const sub      = document.getElementById('dhcp-status-sub');
  const startBtn = document.getElementById('dhcp-start-btn');
  const stopBtn  = document.getElementById('dhcp-stop-btn');

  if (!data.available) {
    dot.style.background   = '#ef4444';
    label.textContent      = 'Unavailable';
    sub.innerHTML = `Docker socket not accessible &mdash; restart the stack to apply the updated compose file:<br>
      <code style="font-size:11px; opacity:.8;">./server.sh stop &amp;&amp; ./server.sh start</code>`;
    startBtn.style.display = 'none';
    stopBtn.style.display  = 'none';
    return;
  }

  if (data.status === 'not_found') {
    dot.style.background   = '#f59e0b';
    label.textContent      = 'Not found';
    sub.textContent        = 'dnsmasq container not found — is the stack running?';
    startBtn.style.display = 'none';
    stopBtn.style.display  = 'none';
    return;
  }

  if (data.running && data.configured) {
    // Container running with a saved config — DHCP is actively serving
    dot.style.background   = '#22c55e';
    label.textContent      = 'Active';
    sub.textContent        = data.started_at
      ? 'Started ' + new Date(data.started_at).toLocaleString()
      : '';
    startBtn.style.display = 'none';
    stopBtn.style.display  = '';
  } else if (data.running && !data.configured) {
    // Container running in idle mode — no DHCP config written yet
    dot.style.background   = '#f59e0b';
    label.textContent      = 'Idle';
    sub.textContent        = 'Not configured — fill in settings below and click ↺ Apply & Restart';
    startBtn.style.display = 'none';
    stopBtn.style.display  = '';
  } else {
    // Container stopped
    dot.style.background   = 'var(--text-muted)';
    label.textContent      = 'Stopped';
    sub.textContent        = data.finished_at && data.finished_at !== '0001-01-01T00:00:00Z'
      ? 'Stopped ' + new Date(data.finished_at).toLocaleString()
      : '';
    startBtn.style.display = data.configured ? '' : 'none';
    stopBtn.style.display  = 'none';
  }
}

function _populateDHCPSettings(s) {
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  const setPh  = (id, v) => { const el = document.getElementById(id); if (el && v) el.placeholder = v; };
  setVal('dhcp-interface',   s.interface);
  setVal('dhcp-gateway',     s.gateway);
  // Prefix dropdown — value must be a string for the <select>
  const prefixEl = document.getElementById('dhcp-prefix');
  if (prefixEl) prefixEl.value = String(s.prefix_length || 24);
  setVal('dhcp-range-start', s.range_start);
  setVal('dhcp-range-end',   s.range_end);
  setVal('dhcp-lease-time',  s.lease_time);
  setVal('dhcp-dns',         s.dhcp_dns);
  setVal('dhcp-server-host', s.server_host);
  // Update placeholder text to reflect the actual host network so that
  // example values shown in empty fields match the real subnet.
  const inferred = _inferFromServerIP(state.serverInfo?.server_host);
  if (inferred) {
    setPh('dhcp-gateway',     inferred.gateway);
    setPh('dhcp-range-start', inferred.range_start);
    setPh('dhcp-range-end',   inferred.range_end);
    setPh('dhcp-server-host', state.serverInfo?.server_host);
  }
  // Refresh the calculated subnet panel to match the loaded values
  _refreshSubnetPanel();
}

function _collectDHCPSettings() {
  const inferred = _inferFromServerIP(state.serverInfo?.server_host);
  return {
    interface:     document.getElementById('dhcp-interface')?.value?.trim()    || 'eth0',
    gateway:       document.getElementById('dhcp-gateway')?.value?.trim()      || null,
    prefix_length: parseInt(document.getElementById('dhcp-prefix')?.value || '24', 10),
    range_start:   document.getElementById('dhcp-range-start')?.value?.trim()  || inferred?.range_start || '192.168.1.100',
    range_end:     document.getElementById('dhcp-range-end')?.value?.trim()    || inferred?.range_end   || '192.168.1.200',
    lease_time:    document.getElementById('dhcp-lease-time')?.value?.trim()   || '12h',
    dhcp_dns:      document.getElementById('dhcp-dns')?.value?.trim()          || null,
    server_host:   document.getElementById('dhcp-server-host')?.value?.trim()  || null,
  };
}

async function dhcpStart() {
  const btn = document.getElementById('dhcp-start-btn');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    const res = await api('/api/dhcp/start', 'POST');
    toast(res.message || 'DHCP server started', 'success');
    await loadDHCPStatus();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Start DHCP';
  }
}

async function dhcpStop() {
  if (!confirm('Stop the DHCP server? PXE clients will no longer receive IP addresses from this server.')) return;
  const btn = document.getElementById('dhcp-stop-btn');
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  try {
    const res = await api('/api/dhcp/stop', 'POST');
    toast(res.message || 'DHCP server stopped', 'success');
    await loadDHCPStatus();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '■ Stop DHCP';
  }
}

async function dhcpSaveSettings() {
  if (!_validateDHCPRange()) { toast('Fix the IP range before saving', 'error'); return; }
  try {
    await api('/api/dhcp/config', 'PUT', _collectDHCPSettings());
    toast('Settings saved', 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function dhcpApplyRestart() {
  if (!_validateDHCPRange()) { toast('Fix the IP range before applying', 'error'); return; }
  try {
    const res = await api('/api/dhcp/apply', 'POST', _collectDHCPSettings());
    toast(res.message || 'Applied', 'success');
    await loadDHCPStatus();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}
