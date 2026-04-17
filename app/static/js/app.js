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
  }
}

// ── View switching ───────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));

  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('active');

  const navItem = document.querySelector(`[data-view="${name}"]`);
  if (navItem) navItem.classList.add('active');

  if (name === 'configs')      loadConfigs();
  if (name === 'artifacts')    loadArtifacts();
}

// ── Wizard step navigation ───────────────────────────────────────────────────
function goToStep(n) {
  if (n === 2 && !state.selectedVersion) {
    toast('Please select an EVE-OS version first.', 'error');
    return;
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

  } catch (err) {
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

    es.addEventListener('progress', e => {
      const data = JSON.parse(e.data);
      updateDownloadUI(data);
    });

    es.addEventListener('done', async e => {
      es.close();
      const data = JSON.parse(e.data);
      updateDownloadUI(data);

      if (data.status === 'ready') {
        try {
          // Activate the config
          await api(`/api/configs/${configId}/activate`, 'POST');
          // Load the script preview
          await loadScriptPreview(configId);
          toast('Configuration activated!', 'success');
          document.getElementById('create-btn').style.display = 'none';
          document.getElementById('dl-script-btn').style.display = '';
          document.getElementById('boot-btn').style.display = '';
          await loadConfigCount();
          resolve();
        } catch (err) {
          toast('Activation error: ' + err.message, 'error');
          reject(err);
        }
      } else {
        const msg = data.error || 'Download failed';
        toast('Download failed: ' + msg, 'error');
        document.getElementById('create-btn').disabled = false;
        document.getElementById('create-btn').innerHTML = '⬇ Retry Download';
        reject(new Error(msg));
      }
    });

    es.onerror = () => {
      es.close();
      // SSE may close naturally — check status via polling
      pollUntilReady(params, configId, resolve, reject);
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
}

async function pollUntilReady(params, configId, resolve, reject) {
  let attempts = 0;
  const maxAttempts = 600;  // 10 minutes at 1s intervals
  const poll = async () => {
    attempts++;
    try {
      const data = await api(`/api/artifacts/status/${encodeURIComponent(params.eve_version)}/${params.architecture}/${params.hv_mode}/${params.variant}`);
      updateDownloadUI(data);
      if (data.status === 'ready') {
        await api(`/api/configs/${configId}/activate`, 'POST');
        await loadScriptPreview(configId);
        toast('Configuration activated!', 'success');
        document.getElementById('create-btn').style.display  = 'none';
        document.getElementById('dl-script-btn').style.display = '';
        document.getElementById('boot-btn').style.display    = '';
        await loadConfigCount();
        resolve();
        return;
      }
      if (data.status === 'failed') {
        reject(new Error(data.error || 'Download failed'));
        return;
      }
    } catch (e) { /* continue polling */ }
    if (attempts < maxAttempts) setTimeout(poll, 1000);
    else reject(new Error('Timed out waiting for download'));
  };
  setTimeout(poll, 2000);
}

async function loadScriptPreview(configId) {
  try {
    const { script } = await api(`/api/configs/${configId}/script`);
    document.getElementById('script-preview-section').style.display = 'block';
    document.getElementById('script-preview-content').textContent = script;
    if (state.serverInfo) {
      document.getElementById('script-url-label').textContent =
        `http://${state.serverInfo.server_host}:${state.serverInfo.webui_port}/ipxe/boot.ipxe`;
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
  a.click();
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
  } catch (e) {
    list.innerHTML = `<div class="info-box error"><span class="info-box-icon">⚠</span><div class="info-box-content"><div class="info-box-title">Error</div><div class="info-box-body">${escHtml(e.message)}</div></div></div>`;
  }
}

async function loadConfigCount() {
  try {
    const configs = await api('/api/configs');
    document.getElementById('config-count').textContent = configs.length;
  } catch (_) {}
}

function renderConfigs(configs) {
  const list = document.getElementById('configs-list');
  if (!configs.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <h3>No configurations yet</h3>
        <p>Create your first EVE-OS boot configuration using the wizard.</p>
      </div>`;
    return;
  }
  list.innerHTML = configs.map(c => `
    <div class="config-item ${c.is_active ? 'is-active' : ''}" id="config-${c.id}">
      <div class="config-item-info">
        <div class="config-item-name">
          ${escHtml(c.name)}
          ${c.is_active ? '<span class="release-badge badge-stable">ACTIVE</span>' : ''}
          <span class="status-pill status-${c.download_status}">${escHtml(c.download_status)}</span>
        </div>
        <div class="config-item-meta">
          ${escHtml(c.eve_version)} · ${escHtml(c.architecture)} · ${escHtml(c.hv_mode)} · ${escHtml(c.variant)}
          · ${escHtml(c.install_disk)}
          ${c.controller_url ? ' · ' + escHtml(c.controller_url) : ''}
        </div>
      </div>
      <div class="config-item-actions">
        ${c.download_status === 'ready' && !c.is_active
          ? `<button class="btn btn-secondary btn-sm" onclick="activateConfig('${c.id}')">Activate</button>`
          : ''}
        ${c.download_status === 'pending' || c.download_status === 'failed'
          ? `<button class="btn btn-secondary btn-sm" onclick="redownload('${c.id}','${c.eve_version}','${c.architecture}','${c.hv_mode}','${c.variant}')">↻ Download</button>`
          : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteConfig('${c.id}')">Delete</button>
      </div>
    </div>`).join('');
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
  try {
    await api(`/api/artifacts/download?eve_version=${encodeURIComponent(version)}&architecture=${arch}&hv_mode=${hv}&variant=${variant}`, 'POST');
    toast('Download started', 'info');
    // Poll and refresh
    const poll = setInterval(async () => {
      const data = await api(`/api/artifacts/status/${encodeURIComponent(version)}/${arch}/${hv}/${variant}`);
      if (data.status === 'ready') {
        clearInterval(poll);
        await loadConfigs();
        toast('Download complete', 'success');
      } else if (data.status === 'failed') {
        clearInterval(poll);
        toast('Download failed: ' + (data.error || ''), 'error');
      }
    }, 2000);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
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
    container.innerHTML = artifacts.map(a => `
      <div class="config-item" style="margin-bottom:10px;">
        <div class="config-item-info">
          <div class="config-item-name">
            ${escHtml(a.version)} / ${escHtml(a.combo)}
            <span class="status-pill status-${a.status}">${escHtml(a.status)}</span>
          </div>
          <div class="config-item-meta">
            Boot mode: ${escHtml(a.boot_mode)} · ${humanSize(a.size_bytes)}
            · ${a.files.length} files
          </div>
        </div>
        <div class="config-item-actions">
          <button class="btn btn-danger btn-sm" onclick="deleteArtifacts('${escHtml(a.version)}','${escHtml(a.combo)}')">Delete</button>
        </div>
      </div>`).join('');
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
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
