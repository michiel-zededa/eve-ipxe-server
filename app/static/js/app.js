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
    // Boot instructions page
    document.getElementById('instr-webui-url').innerHTML = `<code>${info.webui_base}</code>`;
    document.getElementById('instr-tftp').innerHTML     = `<code>tftp://${info.server_host}:69/</code>`;
    document.getElementById('instr-http').innerHTML     = `<code>${info.artifact_http_base}/</code>`;
    document.getElementById('instr-ipxe-url').innerHTML = `<code>${info.ipxe_boot_url}</code>`;
    // Update DHCP config example with real IPs
    const dhcpEl = document.getElementById('dhcp-config-example');
    if (dhcpEl) {
      dhcpEl.textContent = dhcpEl.textContent
        .replaceAll('SERVER_HOST', info.server_host)
        .replaceAll('WEBUI_PORT', info.webui_port);
    }
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

// ── View switching ───────────────────────────────────────────────────────────
function showView(name) {
  // Close any open SSE stream when navigating away
  if (state.downloadEventSource) {
    state.downloadEventSource.close();
    state.downloadEventSource = null;
  }

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  // Clear active from both sidebar items AND mobile nav items
  document.querySelectorAll('.sidebar-item, .mobile-nav-item').forEach(s => s.classList.remove('active'));

  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('active');

  // Mark all elements with data-view matching this name as active
  document.querySelectorAll(`[data-view="${name}"]`).forEach(el => el.classList.add('active'));

  // BUG 3 fix: always clear currentConfigDbId when navigating to wizard
  // (whether or not wizardInProgress — user intent is to start fresh)
  if (name === 'wizard' && !state.wizardInProgress) {
    state.currentConfigDbId = null;
  }

  if (name === 'configs')      loadConfigs();
  if (name === 'artifacts')    loadArtifacts();
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
    kTile.classList.remove('disabled');
    kTile.title = '';
    document.getElementById('variant-jp5').style.display = 'none';
    document.getElementById('variant-jp6').style.display = 'none';
    if (['nvidia-jp5','nvidia-jp6'].includes(state.selectedVariant)) {
      selectVariant('generic');
    }
  }
  updateNvidiaWarning();
}

function selectHV(hv) {
  if (hv === 'k' && state.selectedArch === 'arm64') return;
  state.selectedHV = hv;
  document.querySelectorAll('[data-hv]').forEach(t =>
    t.classList.toggle('selected', t.dataset.hv === hv));
}

function selectScenario(s) {
  state.selectedScenario = s;
  document.querySelectorAll('[data-scenario]').forEach(t =>
    t.classList.toggle('selected', t.dataset.scenario === s));

  // Edge scenario → suggest arm64 defaults
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
    onboarding_key:       val('onboarding-key') || null,
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
  // Close any in-flight SSE stream
  if (state.downloadEventSource) {
    state.downloadEventSource.close();
    state.downloadEventSource = null;
  }

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

  // Clear selected release card
  document.querySelectorAll('.release-card').forEach(c => c.classList.remove('selected'));

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
    const msg = data?.detail || `HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
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
