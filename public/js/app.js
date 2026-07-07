'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  authenticated: false,
  username: null,
  currentPath: '/',
  currentVolume: '',       // active volume label
  volumes: [],             // [{ label, mountPath }]
  viewMode: localStorage.getItem('viewMode') || 'grid',
  selected: new Set(),
  files: [],
  s3Prefix: '',
  s3Bucket: '',
  s3FlatMode: false,
  companyName: 'PVC File Browser',
  logoSrc: '',
};

// ─── API ──────────────────────────────────────────────────────────────────────
const api = {
  async request(method, url, body, isFormData) {
    const opts = { method, credentials: 'same-origin' };
    if (body && !isFormData) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    } else if (isFormData) {
      opts.body = body;
    }
    const res = await fetch(url, opts);
    if (res.status === 401) { showLogin(); return null; }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res;
  },
  get: (url) => api.request('GET', url),
  post: (url, body) => api.request('POST', url, body),
  del: (url, body) => api.request('DELETE', url, body),
  files: {
    list: (p, vol) => api.get(`/api/files?path=${encodeURIComponent(p)}&volume=${encodeURIComponent(vol || state.currentVolume)}`),
    info: (p, vol) => api.get(`/api/files/info?path=${encodeURIComponent(p)}&volume=${encodeURIComponent(vol || state.currentVolume)}`),
    mkdir: (p) => api.post('/api/files/mkdir', { path: p, volume: state.currentVolume }),
    delete: (p) => api.del(`/api/files?path=${encodeURIComponent(p)}&volume=${encodeURIComponent(state.currentVolume)}`),
    move: (src, dst, srcVolume, dstVolume) => api.post('/api/files/move', {
      src, dst,
      srcVolume: srcVolume || state.currentVolume,
      dstVolume: dstVolume || srcVolume || state.currentVolume,
    }),
    copy: (src, dst, srcVolume, dstVolume) => api.post('/api/files/copy', {
      src, dst,
      srcVolume: srcVolume || state.currentVolume,
      dstVolume: dstVolume || srcVolume || state.currentVolume,
    }),
    chmod: (p, mode, recursive) => api.post('/api/files/chmod', { path: p, mode, recursive, volume: state.currentVolume }),
    chown: (p, uid, gid, recursive) => api.post('/api/files/chown', { path: p, uid, gid, recursive, volume: state.currentVolume }),
    previewUrl: (p) => `/api/files/preview?path=${encodeURIComponent(p)}&volume=${encodeURIComponent(state.currentVolume)}`,
    downloadUrl: (p) => `/api/files/download?path=${encodeURIComponent(p)}&volume=${encodeURIComponent(state.currentVolume)}`,
  },
  s3: {
    getConfig: () => api.get('/api/s3/config'),
    saveConfig: (cfg) => api.post('/api/s3/config', cfg),
    list: (prefix, bucket, flat) => api.get(`/api/s3/list?prefix=${encodeURIComponent(prefix)}&bucket=${encodeURIComponent(bucket || '')}&flat=${flat ? 'true' : 'false'}`),
    copyToPvc: (key, bucket, targetPath) => api.post('/api/s3/copy-to-pvc', { key, bucket, targetPath }),
    downloadUrl: (key, bucket) => `/api/s3/download?key=${encodeURIComponent(key)}&bucket=${encodeURIComponent(bucket || '')}`,
    previewUrl: (key, bucket) => `/api/s3/preview?key=${encodeURIComponent(key)}&bucket=${encodeURIComponent(bucket || '')}`,
  },
  system: { info: () => api.get('/api/system/info') },
};

// ─── Upload with progress ──────────────────────────────────────────────────────
function uploadFiles(files, relativePaths, targetPath) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('path', targetPath);
    fd.append('volume', state.currentVolume);
    files.forEach((file, i) => {
      fd.append('files', file);
      fd.append('relativePaths[]', relativePaths ? relativePaths[i] : file.name);
    });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload');
    xhr.withCredentials = true;

    showUploadProgress(0);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) showUploadProgress(Math.round(e.loaded / e.total * 100));
    };
    xhr.onload = () => {
      hideUploadProgress();
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) reject(new Error(data.error || 'Upload failed'));
        else resolve(data);
      } catch { reject(new Error('Upload failed')); }
    };
    xhr.onerror = () => { hideUploadProgress(); reject(new Error('Upload failed')); };
    xhr.send(fd);
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + sizes[i];
}

function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDateShort(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function pathJoin(...parts) {
  return ('/' + parts.map(p => p.replace(/^\/|\/$/g, '')).filter(Boolean).join('/')).replace(/\/+/g, '/') || '/';
}

function pathParent(p) {
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  parts.pop();
  return '/' + parts.join('/');
}

function pathBasename(p) {
  return p.replace(/\/+$/, '').split('/').pop() || '';
}

function mimeCategory(mimeType, name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (!mimeType || mimeType === 'inode/directory') return 'dir';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/') || ['js','ts','json','yaml','yml','xml','md','sh','py','rb','go','rs','java','c','cpp','h','css','html','env','toml','ini','conf'].includes(ext)) return 'text';
  return 'binary';
}

// ─── File Icons ───────────────────────────────────────────────────────────────
const COLORS = {
  dir: '#F77737', image: '#833AB4', video: '#E1306C', audio: '#FCAF45',
  pdf: '#E53935', text: '#2196F3', binary: '#9E9E9E',
};

function fileIcon(file) {
  const cat = mimeCategory(file.mimeType, file.name);
  const c = COLORS[cat] || '#9E9E9E';
  if (cat === 'dir') return `<svg viewBox="0 0 24 24" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>`;
  if (cat === 'image') return `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="${c}"/><polyline points="21 15 16 10 5 21"/></svg>`;
  if (cat === 'video') return `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/></svg>`;
  if (cat === 'audio') return `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  if (cat === 'pdf') return `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
  if (cat === 'text') return `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', dur = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  el.innerHTML = `<span style="font-size:16px;font-weight:700">${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), dur);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function showModal(html, size = '') {
  const overlay = document.getElementById('modal-overlay');
  const box = document.getElementById('modal-box');
  document.getElementById('modal-content').innerHTML = html;
  box.className = 'modal-box' + (size ? ` modal-${size}` : '');
  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-content').innerHTML = '';
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

// ─── Context Menu ─────────────────────────────────────────────────────────────
function showContextMenu(x, y, items) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = items.map(item => {
    if (item === '-') return '<div class="ctx-divider"></div>';
    return `<button class="ctx-item${item.danger ? ' danger' : ''}" data-action="${item.action}">${item.icon || ''}<span>${item.label}</span></button>`;
  }).join('');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');

  items.forEach(item => {
    if (item === '-') return;
    const btn = menu.querySelector(`[data-action="${item.action}"]`);
    if (btn && item.handler) btn.addEventListener('click', () => { hideContextMenu(); item.handler(); });
  });

  // Adjust if off screen
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (x - r.width) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (y - r.height) + 'px';
  });
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideContextMenu(); closeModal(); } });

// ─── Upload Progress ──────────────────────────────────────────────────────────
function showUploadProgress(pct) {
  const bar = document.getElementById('upload-progress-bar');
  bar.classList.remove('hidden');
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('upload-progress-pct').textContent = pct + '%';
  document.getElementById('upload-progress-label').textContent = pct < 100 ? 'Uploading...' : 'Processing...';
}

function hideUploadProgress() {
  setTimeout(() => document.getElementById('upload-progress-bar').classList.add('hidden'), 800);
}

// ─── Login ────────────────────────────────────────────────────────────────────
function showLogin() {
  state.authenticated = false;
  document.getElementById('login-page').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

async function loadConfig() {
  const cfg = await api.get('/api/config');
  if (!cfg) return;
  state.companyName = cfg.companyName;
  state.logoSrc = cfg.logoSrc;

  document.title = cfg.companyName;
  document.getElementById('login-company-name').textContent = cfg.companyName;
  document.getElementById('sidebar-company').textContent = cfg.companyName;

  const logoHtml = cfg.logoSrc
    ? `<img src="${cfg.logoSrc}" alt="${cfg.companyName}" />`
    : `<div class="logo-initials">${cfg.companyName.slice(0, 2).toUpperCase()}</div>`;

  document.getElementById('login-logo-wrap').innerHTML = logoHtml;

  const sidebarLogo = document.getElementById('sidebar-logo');
  sidebarLogo.innerHTML = cfg.logoSrc
    ? `<img src="${cfg.logoSrc}" alt="" />`
    : `<span class="logo-text">${cfg.companyName.slice(0, 2).toUpperCase()}</span>`;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.success) {
      state.authenticated = true;
      state.username = data.username;
      await startApp();
    } else {
      errEl.textContent = data.error || 'Login failed';
      errEl.classList.remove('hidden');
    }
  } catch {
    errEl.textContent = 'Connection error';
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api.post('/api/auth/logout');
  showLogin();
});

// ─── Navigation ───────────────────────────────────────────────────────────────
function setView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.remove('hidden');
  const navItem = document.querySelector(`[data-view="${name}"]`);
  if (navItem) navItem.classList.add('active');

  if (name === 's3') loadS3View();
  if (name === 'system') loadSystemView();
}

document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

// ─── File Browser ─────────────────────────────────────────────────────────────
function renderBreadcrumb(p) {
  const parts = p.replace(/^\//, '').split('/').filter(Boolean);
  const bc = document.getElementById('breadcrumb');
  let html = `<span class="breadcrumb-item${p === '/' ? ' active' : ''}" data-path="/">Home</span>`;
  let cumPath = '';
  parts.forEach((part, i) => {
    cumPath += '/' + part;
    const isLast = i === parts.length - 1;
    html += `<span class="breadcrumb-sep">›</span><span class="breadcrumb-item${isLast ? ' active' : ''}" data-path="${cumPath}">${part}</span>`;
  });
  bc.innerHTML = html;
  bc.querySelectorAll('[data-path]').forEach(el => {
    if (!el.classList.contains('active')) {
      el.addEventListener('click', () => navigateTo(el.dataset.path));
    }
  });
}

async function loadVolumes() {
  const vols = await api.get('/api/volumes');
  if (!vols || !Array.isArray(vols)) return;
  state.volumes = vols;
  if (!state.currentVolume || !vols.find(v => v.label === state.currentVolume)) {
    state.currentVolume = vols[0]?.label || '';
  }
  renderVolumeTabs();
}

function renderVolumeTabs() {
  const tabBar = document.getElementById('volume-tabs');
  if (!tabBar) return;
  if (state.volumes.length <= 1) { tabBar.classList.add('hidden'); return; }
  tabBar.classList.remove('hidden');
  tabBar.innerHTML = state.volumes.map(v => `
    <button class="volume-tab${v.label === state.currentVolume ? ' active' : ''}" data-vol="${v.label}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
      ${v.label}
      <span class="vol-path">${v.mountPath}</span>
    </button>
  `).join('');

  tabBar.querySelectorAll('.volume-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      if (tab.dataset.vol === state.currentVolume) return;
      state.currentVolume = tab.dataset.vol;
      state.currentPath = '/';
      state.selected.clear();
      renderVolumeTabs();
      await navigateTo('/');
    });
  });
}

async function navigateTo(p) {
  state.currentPath = p;
  state.selected.clear();
  updateSelectionBar();
  renderBreadcrumb(p);
  setView('browser');
  await loadFiles(p);
}

async function loadFiles(p) {
  const loading = document.getElementById('file-loading');
  const grid = document.getElementById('file-grid');
  const list = document.getElementById('file-list');
  const empty = document.getElementById('file-empty');

  loading.classList.remove('hidden');
  grid.classList.add('hidden');
  list.classList.add('hidden');
  empty.classList.add('hidden');

  const data = await api.files.list(p);
  loading.classList.add('hidden');

  if (!data) return;
  state.files = data.files || [];

  if (state.files.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  if (state.viewMode === 'grid') renderGrid(state.files);
  else renderList(state.files);
}

function renderGrid(files) {
  const grid = document.getElementById('file-grid');
  grid.classList.remove('hidden');
  grid.innerHTML = files.map((f, i) => {
    const cat = mimeCategory(f.mimeType, f.name);
    const thumb = cat === 'image'
      ? `<img class="file-card-thumb" src="${api.files.previewUrl(f.path)}" alt="${f.name}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="file-card-icon" style="display:none">${fileIcon(f)}</div>`
      : `<div class="file-card-icon">${fileIcon(f)}</div>`;

    return `<div class="file-card" data-index="${i}" data-path="${f.path}" data-isdir="${f.isDirectory}">
      <div class="file-card-check"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
      ${thumb}
      <div class="file-card-name" title="${f.name}">${f.name}</div>
      <div class="file-card-meta">${f.isDirectory ? 'Folder' : fmtSize(f.size)}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.file-card').forEach(card => {
    const i = parseInt(card.dataset.index);
    const f = state.files[i];

    card.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        toggleSelect(f.path, card);
      } else if (f.isDirectory) {
        navigateTo(f.path);
      } else {
        previewFile(f);
      }
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.selected.has(f.path)) {
        state.selected.clear();
        document.querySelectorAll('.file-card.selected').forEach(c => c.classList.remove('selected'));
        toggleSelect(f.path, card);
      }
      showFileContextMenu(e.clientX, e.clientY, f);
    });
  });
}

function renderList(files) {
  const list = document.getElementById('file-list');
  list.classList.remove('hidden');
  const tbody = document.getElementById('file-list-body');
  tbody.innerHTML = files.map((f, i) => `
    <tr data-index="${i}" data-path="${f.path}">
      <td><input type="checkbox" class="row-check" data-path="${f.path}" /></td>
      <td>
        <div class="file-name-cell" data-isdir="${f.isDirectory}">
          <div style="width:18px;height:18px;flex-shrink:0">${fileIcon(f)}</div>
          <span>${f.name}</span>
        </div>
      </td>
      <td>${f.isDirectory ? '-' : fmtSize(f.size)}</td>
      <td>${fmtDateShort(f.modified)}</td>
      <td><span class="info-badge">${f.uid}:${f.gid}</span></td>
      <td><code>${f.mode}</code></td>
      <td>
        <div class="file-actions">
          ${f.isDirectory ? `<button class="btn btn-sm" title="Open" data-action="open" data-path="${f.path}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button>` : ''}
          ${!f.isDirectory ? `<button class="btn btn-sm" title="Preview" data-action="preview" data-index="${i}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>` : ''}
          <button class="btn btn-sm" title="Download" data-action="download" data-path="${f.path}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>
          <button class="btn btn-sm" title="Permissions" data-action="perms" data-path="${f.path}" data-isdir="${f.isDirectory}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></button>
          <button class="btn btn-sm btn-danger" title="Delete" data-action="delete" data-path="${f.path}" data-name="${f.name}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg></button>
        </div>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.file-name-cell').forEach((cell, i) => {
    const f = state.files[i];
    cell.style.cursor = 'pointer';
    cell.addEventListener('click', () => {
      if (f.isDirectory) navigateTo(f.path);
      else previewFile(f);
    });
    cell.parentElement.parentElement.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showFileContextMenu(e.clientX, e.clientY, f);
    });
  });

  tbody.querySelectorAll('[data-action]').forEach(btn => {
    const action = btn.dataset.action;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fp = btn.dataset.path;
      const name = btn.dataset.name;
      const idx = btn.dataset.index;
      if (action === 'open') navigateTo(fp);
      else if (action === 'preview') previewFile(state.files[parseInt(idx)]);
      else if (action === 'download') window.open(api.files.downloadUrl(fp), '_blank');
      else if (action === 'delete') confirmDelete([fp], [name || pathBasename(fp)]);
      else if (action === 'perms') showPermissionsModal(fp, btn.dataset.isdir === 'true');
    });
  });

  tbody.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const fp = cb.dataset.path;
      const row = cb.closest('tr');
      if (cb.checked) { state.selected.add(fp); row.classList.add('selected'); }
      else { state.selected.delete(fp); row.classList.remove('selected'); }
      updateSelectionBar();
    });
  });

  document.getElementById('select-all').addEventListener('change', (e) => {
    const checked = e.target.checked;
    tbody.querySelectorAll('.row-check').forEach(cb => {
      cb.checked = checked;
      const fp = cb.dataset.path;
      const row = cb.closest('tr');
      if (checked) { state.selected.add(fp); row.classList.add('selected'); }
      else { state.selected.delete(fp); row.classList.remove('selected'); }
    });
    updateSelectionBar();
  });
}

function toggleSelect(fp, card) {
  if (state.selected.has(fp)) {
    state.selected.delete(fp);
    card?.classList.remove('selected');
  } else {
    state.selected.add(fp);
    card?.classList.add('selected');
  }
  updateSelectionBar();
}

function updateSelectionBar() {
  const bar = document.getElementById('selection-bar');
  const count = state.selected.size;
  const total = state.files.length;
  const allBtn = document.getElementById('btn-select-all');
  document.getElementById('selection-count').textContent = `${count} of ${total} selected`;
  if (allBtn) allBtn.textContent = (count === total && total > 0) ? '✕ Deselect All' : '☑ Select All';
  if (count > 0) bar.classList.remove('hidden');
  else bar.classList.add('hidden');
}

function clearSelection() {
  state.selected.clear();
  document.querySelectorAll('.file-card.selected').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.row-check:checked').forEach(c => { c.checked = false; c.closest('tr')?.classList.remove('selected'); });
  const sa = document.getElementById('select-all');
  if (sa) sa.checked = false;
  updateSelectionBar();
}

function showBulkPermissionsModal(paths) {
  const count = paths.length;
  showModal(`
    <div class="modal-header">
      <h2>Change Permissions</h2>
      <p>Apply to <strong>${count} selected item${count > 1 ? 's' : ''}</strong></p>
    </div>
    <div class="modal-body">
      <div class="divider"></div>
      <h4 style="margin-bottom:12px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-light)">chmod — Change Mode</h4>
      <div class="field-row">
        <label>Octal Mode</label>
        <input id="bulk-chmod-mode" type="text" value="755" placeholder="777" maxlength="4" style="font-size:20px;font-weight:700;letter-spacing:4px;font-family:monospace" />
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        ${[['777','All read/write/exec'],['755','Standard dirs'],['644','Standard files'],['600','Owner only'],['775','Group write']].map(([m,d]) =>
          `<button class="btn btn-sm quick-mode" data-mode="${m}" title="${d}">${m}</button>`
        ).join('')}
      </div>
      <div class="checkbox-row" style="margin-bottom:16px">
        <input type="checkbox" id="bulk-chmod-recursive" checked />
        <label for="bulk-chmod-recursive">Recursive (apply to contents of folders)</label>
      </div>
      <button class="btn btn-gradient w-full" id="apply-bulk-chmod" style="justify-content:center">
        Apply chmod to ${count} item${count > 1 ? 's' : ''}
      </button>

      <div class="divider"></div>
      <h4 style="margin-bottom:12px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-light)">chown — Change Ownership</h4>
      <div class="row-2">
        <div class="field-row">
          <label>UID</label>
          <input id="bulk-chown-uid" type="number" placeholder="1000" min="0" />
        </div>
        <div class="field-row">
          <label>GID</label>
          <input id="bulk-chown-gid" type="number" placeholder="1000" min="0" />
        </div>
      </div>
      <div class="hint" style="margin-bottom:10px">Check <strong>System</strong> tab for current UID/GID. Requires root or CAP_CHOWN.</div>
      <div class="checkbox-row" style="margin-bottom:16px">
        <input type="checkbox" id="bulk-chown-recursive" checked />
        <label for="bulk-chown-recursive">Recursive</label>
      </div>
      <button class="btn btn-gradient w-full" id="apply-bulk-chown" style="justify-content:center">
        Apply chown to ${count} item${count > 1 ? 's' : ''}
      </button>

      <div id="bulk-perms-result" style="margin-top:14px"></div>
    </div>
  `);

  document.querySelectorAll('.quick-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('bulk-chmod-mode').value = btn.dataset.mode;
      document.querySelectorAll('.quick-mode').forEach(b => b.classList.remove('btn-gradient'));
      btn.classList.add('btn-gradient');
    });
  });

  document.getElementById('apply-bulk-chmod').addEventListener('click', async () => {
    const mode = document.getElementById('bulk-chmod-mode').value.trim();
    const recursive = document.getElementById('bulk-chmod-recursive').checked;
    if (!mode) return;

    const resultEl = document.getElementById('bulk-perms-result');
    resultEl.innerHTML = `<div class="loading-spinner" style="padding:12px 0"><div class="spinner"></div></div>`;

    let ok = 0, fail = 0;
    for (const p of paths) {
      const r = await api.files.chmod(p, mode, recursive);
      if (r && r.success) ok++; else fail++;
    }

    resultEl.innerHTML = `<div class="toast ${fail === 0 ? 'success' : 'error'}" style="position:static;animation:none;margin-top:8px">
      ${fail === 0 ? '✓' : '✕'} chmod ${mode}: ${ok} succeeded${fail > 0 ? `, ${fail} failed (may need root)` : ''}
    </div>`;
    if (ok > 0) { await loadFiles(state.currentPath); }
  });

  document.getElementById('apply-bulk-chown').addEventListener('click', async () => {
    const uid = document.getElementById('bulk-chown-uid').value;
    const gid = document.getElementById('bulk-chown-gid').value;
    const recursive = document.getElementById('bulk-chown-recursive').checked;
    if (!uid || !gid) { toast('Enter both UID and GID', 'error'); return; }

    const resultEl = document.getElementById('bulk-perms-result');
    resultEl.innerHTML = `<div class="loading-spinner" style="padding:12px 0"><div class="spinner"></div></div>`;

    let ok = 0, fail = 0;
    for (const p of paths) {
      const r = await api.files.chown(p, parseInt(uid), parseInt(gid), recursive);
      if (r && r.success) ok++; else fail++;
    }

    resultEl.innerHTML = `<div class="toast ${fail === 0 ? 'success' : 'error'}" style="position:static;animation:none;margin-top:8px">
      ${fail === 0 ? '✓' : '✕'} chown ${uid}:${gid}: ${ok} succeeded${fail > 0 ? `, ${fail} failed (needs root/CAP_CHOWN)` : ''}
    </div>`;
    if (ok > 0) { await loadFiles(state.currentPath); }
  });
}

// ─── Context Menu ─────────────────────────────────────────────────────────────
function showFileContextMenu(x, y, f) {
  const iconSvg = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15">${path}</svg>`;
  showContextMenu(x, y, [
    f.isDirectory ? {
      label: 'Open', action: 'open', icon: iconSvg('<path d="M5 12h14M12 5l7 7-7 7"/>'),
      handler: () => navigateTo(f.path)
    } : {
      label: 'Preview', action: 'preview', icon: iconSvg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
      handler: () => previewFile(f)
    },
    {
      label: 'Download', action: 'dl', icon: iconSvg('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
      handler: () => window.open(api.files.downloadUrl(f.path), '_blank')
    },
    '-',
    {
      label: 'Rename', action: 'rename', icon: iconSvg('<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
      handler: () => showRenameModal(f)
    },
    {
      label: 'Move to...', action: 'move', icon: iconSvg('<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>'),
      handler: () => showMoveModal([f.path], 'move')
    },
    {
      label: 'Copy to...', action: 'copy', icon: iconSvg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>'),
      handler: () => showMoveModal([f.path], 'copy')
    },
    {
      label: 'Permissions', action: 'perms', icon: iconSvg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>'),
      handler: () => showPermissionsModal(f.path, f.isDirectory)
    },
    { label: 'Info', action: 'info', icon: iconSvg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'), handler: () => showFileInfo(f) },
    '-',
    {
      label: 'Delete', action: 'del', danger: true, icon: iconSvg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
      handler: () => confirmDelete([f.path], [f.name])
    },
  ]);
}

// ─── File Operations ──────────────────────────────────────────────────────────
async function confirmDelete(paths, names) {
  const label = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
  showModal(`
    <div class="modal-header"><h2>Delete ${label}?</h2><p>This action cannot be undone.</p></div>
    <div class="modal-footer">
      <button class="btn" id="cancel-del">Cancel</button>
      <button class="btn btn-danger" id="confirm-del">Delete</button>
    </div>
  `);
  document.getElementById('cancel-del').onclick = closeModal;
  document.getElementById('confirm-del').onclick = async () => {
    closeModal();
    let failed = 0;
    for (const p of paths) {
      const r = await api.files.delete(p);
      if (!r || r.error) failed++;
    }
    if (failed === 0) toast(`Deleted ${label}`, 'success');
    else toast(`Failed to delete some files`, 'error');
    state.selected.clear();
    await loadFiles(state.currentPath);
  };
}

function showMoveModal(paths, op) {
  const label = paths.length === 1 ? `"${pathBasename(paths[0])}"` : `${paths.length} items`;
  const srcVolume = state.currentVolume;
  const showVolPicker = state.volumes.length > 1;
  const volOptions = state.volumes.map(v =>
    `<option value="${v.label}"${v.label === srcVolume ? ' selected' : ''}>${v.label}</option>`
  ).join('');
  showModal(`
    <div class="modal-header"><h2>${op === 'move' ? 'Move' : 'Copy'} ${label}</h2><p>Enter destination path${showVolPicker ? ' and volume' : ' (relative to data root)'}</p></div>
    <div class="modal-body">
      ${showVolPicker ? `
      <div class="field-row">
        <label>Destination Volume (PVC)</label>
        <select id="dst-volume">${volOptions}</select>
        <div class="hint">Pick a different PVC to ${op} across volumes</div>
      </div>` : ''}
      <div class="field-row">
        <label>Destination Path</label>
        <input id="dst-path" type="text" value="${state.currentPath}" placeholder="/destination/folder" />
        <div class="hint">e.g. /uploads/documents</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="cancel-mv">Cancel</button>
      <button class="btn btn-gradient" id="confirm-mv">${op === 'move' ? 'Move' : 'Copy'}</button>
    </div>
  `);
  document.getElementById('cancel-mv').onclick = closeModal;
  document.getElementById('confirm-mv').onclick = async () => {
    const dst = document.getElementById('dst-path').value.trim();
    if (!dst) return;
    const dstVolume = showVolPicker ? document.getElementById('dst-volume').value : srcVolume;
    closeModal();
    let ok = 0;
    for (const src of paths) {
      const name = pathBasename(src);
      const dstPath = pathJoin(dst, name);
      const fn = op === 'move' ? api.files.move : api.files.copy;
      const r = await fn(src, dstPath, srcVolume, dstVolume);
      if (r && !r.error) ok++;
    }
    const crossVol = dstVolume !== srcVolume;
    toast(`${op === 'move' ? 'Moved' : 'Copied'} ${ok} item(s)${crossVol ? ` to "${dstVolume}"` : ''}`, ok > 0 ? 'success' : 'error');
    state.selected.clear();
    await loadFiles(state.currentPath);
  };
}

function showRenameModal(f) {
  showModal(`
    <div class="modal-header"><h2>Rename</h2></div>
    <div class="modal-body">
      <div class="field-row">
        <label>New name</label>
        <input id="new-name" type="text" value="${f.name}" />
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="cancel-ren">Cancel</button>
      <button class="btn btn-gradient" id="confirm-ren">Rename</button>
    </div>
  `);
  const inp = document.getElementById('new-name');
  const ext = f.name.lastIndexOf('.');
  if (ext > 0 && !f.isDirectory) inp.setSelectionRange(0, ext);
  else inp.select();
  inp.focus();

  document.getElementById('cancel-ren').onclick = closeModal;
  document.getElementById('confirm-ren').onclick = async () => {
    const newName = inp.value.trim();
    if (!newName || newName === f.name) { closeModal(); return; }
    const dst = pathJoin(pathParent(f.path), newName);
    const r = await api.files.move(f.path, dst);
    if (r && r.success) { toast(`Renamed to "${newName}"`, 'success'); }
    else { toast(r?.error || 'Rename failed', 'error'); }
    closeModal();
    await loadFiles(state.currentPath);
  };
}

function showPermissionsModal(fp, isDir) {
  showModal(`
    <div class="modal-header">
      <h2>Permissions & Ownership</h2>
      <p>${fp}</p>
    </div>
    <div class="modal-body">
      <div class="divider"></div>
      <h4 style="margin-bottom:12px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-light)">Change Mode (chmod)</h4>
      <div class="row-2">
        <div class="field-row">
          <label>Octal Mode</label>
          <input id="chmod-mode" type="text" value="755" placeholder="777" maxlength="4" />
          <div class="hint">e.g. 755, 777, 644</div>
        </div>
        <div class="field-row" style="justify-content:flex-end;padding-top:20px">
          ${isDir ? '<div class="checkbox-row"><input type="checkbox" id="chmod-recursive" /><label for="chmod-recursive">Recursive</label></div>' : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button class="btn btn-sm" data-mode="777">777 (all)</button>
        <button class="btn btn-sm" data-mode="755">755 (standard)</button>
        <button class="btn btn-sm" data-mode="644">644 (read-only)</button>
      </div>
      <button class="btn btn-gradient btn-sm" id="apply-chmod">Apply chmod</button>

      <div class="divider"></div>
      <h4 style="margin-bottom:12px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-light)">Change Ownership (chown)</h4>
      <div class="row-2">
        <div class="field-row">
          <label>UID</label>
          <input id="chown-uid" type="number" placeholder="1000" />
        </div>
        <div class="field-row">
          <label>GID</label>
          <input id="chown-gid" type="number" placeholder="1000" />
        </div>
      </div>
      ${isDir ? '<div class="checkbox-row" style="margin-bottom:12px"><input type="checkbox" id="chown-recursive" /><label for="chown-recursive">Recursive (-R)</label></div>' : ''}
      <div class="hint" style="margin-bottom:10px">Run <code>id</code> in terminal to get UID/GID. Requires root/CAP_CHOWN.</div>
      <button class="btn btn-gradient btn-sm" id="apply-chown">Apply chown</button>
    </div>
  `);

  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => { document.getElementById('chmod-mode').value = btn.dataset.mode; });
  });

  document.getElementById('apply-chmod').onclick = async () => {
    const mode = document.getElementById('chmod-mode').value.trim();
    const recursive = document.getElementById('chmod-recursive')?.checked;
    const r = await api.files.chmod(fp, mode, recursive);
    if (r && r.success) toast('Permissions updated', 'success');
    else toast(r?.error || 'chmod failed (needs privileges)', 'error');
  };

  document.getElementById('apply-chown').onclick = async () => {
    const uid = document.getElementById('chown-uid').value;
    const gid = document.getElementById('chown-gid').value;
    const recursive = document.getElementById('chown-recursive')?.checked;
    if (!uid || !gid) { toast('Enter both UID and GID', 'error'); return; }
    const r = await api.files.chown(fp, parseInt(uid), parseInt(gid), recursive);
    if (r && r.success) toast('Ownership updated', 'success');
    else toast(r?.error || 'chown failed (needs root/CAP_CHOWN)', 'error');
  };
}

async function showFileInfo(f) {
  const info = await api.files.info(f.path);
  if (!info) return;
  showModal(`
    <div class="modal-header"><h2>File Info</h2><p>${info.name}</p></div>
    <div class="modal-body">
      <div class="info-card" style="border:none;padding:0">
        ${[
          ['Path', info.path],
          ['Type', info.isDirectory ? 'Directory' : (info.mimeType || 'File')],
          ['Size', fmtSize(info.size)],
          ['Modified', fmtDate(info.modified)],
          ['UID', info.uid],
          ['GID', info.gid],
          ['Mode', info.mode],
        ].map(([k, v]) => `<div class="info-row"><span class="info-label">${k}</span><span class="info-value">${v}</span></div>`).join('')}
      </div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModal()">Close</button></div>
  `);
}

// ─── Preview ──────────────────────────────────────────────────────────────────
function previewFile(f) {
  const cat = mimeCategory(f.mimeType, f.name);
  const url = api.files.previewUrl(f.path);
  let content = '';

  if (cat === 'image') {
    content = `<div class="modal-header"><h2>${f.name}</h2><p>${fmtSize(f.size)}</p></div>
      <div class="modal-body" style="text-align:center">
        <img class="preview-img" src="${url}" alt="${f.name}" />
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Close</button>
        <a class="btn btn-gradient" href="${api.files.downloadUrl(f.path)}" download="${f.name}">Download</a>
      </div>`;
    showModal(content, 'lg');
  } else if (cat === 'video') {
    content = `<div class="modal-header"><h2>${f.name}</h2></div>
      <div class="modal-body">
        <video class="preview-video" controls src="${url}" preload="metadata">Your browser doesn't support video.</video>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Close</button>
        <a class="btn btn-gradient" href="${api.files.downloadUrl(f.path)}" download="${f.name}">Download</a>
      </div>`;
    showModal(content, 'lg');
  } else if (cat === 'audio') {
    content = `<div class="modal-header"><h2>${f.name}</h2></div>
      <div class="modal-body">
        <audio class="preview-audio" controls src="${url}">Your browser doesn't support audio.</audio>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Close</button>
        <a class="btn btn-gradient" href="${api.files.downloadUrl(f.path)}" download="${f.name}">Download</a>
      </div>`;
    showModal(content);
  } else if (cat === 'pdf') {
    content = `<div class="modal-header"><h2>${f.name}</h2></div>
      <div class="modal-body"><iframe class="preview-pdf" src="${url}"></iframe></div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Close</button>
        <a class="btn btn-gradient" href="${api.files.downloadUrl(f.path)}" download="${f.name}">Download</a>
      </div>`;
    showModal(content, 'xl');
  } else if (cat === 'text') {
    content = `<div class="modal-header"><h2>${f.name}</h2><p>${fmtSize(f.size)}</p></div>
      <div class="modal-body">
        <div class="preview-code" id="preview-code-wrap"><div class="loading-spinner"><div class="spinner"></div></div></div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Close</button>
        <a class="btn btn-gradient" href="${api.files.downloadUrl(f.path)}" download="${f.name}">Download</a>
      </div>`;
    showModal(content, 'lg');
    fetch(url).then(r => r.text()).then(text => {
      const wrap = document.getElementById('preview-code-wrap');
      if (wrap) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = text.slice(0, 500000);
        pre.appendChild(code);
        wrap.innerHTML = '';
        wrap.appendChild(pre);
        hljs.highlightElement(code);
      }
    }).catch(() => {
      const wrap = document.getElementById('preview-code-wrap');
      if (wrap) wrap.textContent = 'Unable to load file content.';
    });
  } else {
    showFileInfo(f);
  }
}

// ─── Upload ───────────────────────────────────────────────────────────────────
function showUploadModal() {
  showModal(`
    <div class="modal-header"><h2>Upload Files</h2><p>Upload to: <strong>${state.currentPath}</strong></p></div>
    <div class="modal-body">
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        <button class="btn btn-gradient" id="up-files-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          Select Files
        </button>
        <button class="btn" id="up-folder-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 2h9a2 2 0 012 2z"/></svg>
          Select Folder
        </button>
      </div>
      <div id="up-file-list" style="max-height:200px;overflow-y:auto;font-size:13px;color:var(--text-light)">
        <p>No files selected</p>
      </div>
    </div>
  `);

  document.getElementById('up-files-btn').onclick = () => document.getElementById('file-input').click();
  document.getElementById('up-folder-btn').onclick = () => document.getElementById('folder-input').click();
}

function handleFilesSelected(fileList, isFolder) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  const relativePaths = isFolder ? files.map(f => f.webkitRelativePath || f.name) : files.map(f => f.name);

  const listEl = document.getElementById('up-file-list');
  if (listEl) {
    listEl.innerHTML = `<p style="margin-bottom:8px">${files.length} file(s) selected:</p>` +
      files.slice(0, 10).map(f => `<div style="padding:4px 0;border-bottom:1px solid var(--border)">${isFolder ? (f.webkitRelativePath || f.name) : f.name} <span style="color:var(--text-light)">${fmtSize(f.size)}</span></div>`).join('') +
      (files.length > 10 ? `<p style="color:var(--text-light);margin-top:8px">...and ${files.length - 10} more</p>` : '') +
      `<div style="margin-top:16px"><button class="btn btn-gradient" id="start-upload">Upload ${files.length} file(s)</button></div>`;

    document.getElementById('start-upload').onclick = async () => {
      closeModal();
      try {
        await uploadFiles(files, relativePaths, state.currentPath);
        toast(`Uploaded ${files.length} file(s)`, 'success');
        await loadFiles(state.currentPath);
      } catch (err) {
        toast(err.message || 'Upload failed', 'error');
      }
    };
  } else {
    closeModal();
    uploadFiles(files, relativePaths, state.currentPath)
      .then(() => { toast(`Uploaded ${files.length} file(s)`, 'success'); loadFiles(state.currentPath); })
      .catch(err => toast(err.message || 'Upload failed', 'error'));
  }
}

document.getElementById('file-input').addEventListener('change', (e) => {
  handleFilesSelected(e.target.files, false);
  e.target.value = '';
});

document.getElementById('folder-input').addEventListener('change', (e) => {
  handleFilesSelected(e.target.files, true);
  e.target.value = '';
});

// Drag and drop
const mainContent = document.querySelector('.main-content');
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0;

mainContent.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.remove('hidden');
});
mainContent.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.add('hidden'); }
});
mainContent.addEventListener('dragover', (e) => e.preventDefault());
mainContent.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.add('hidden');
  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) return;
  try {
    await uploadFiles(files, files.map(f => f.name), state.currentPath);
    toast(`Uploaded ${files.length} file(s)`, 'success');
    await loadFiles(state.currentPath);
  } catch (err) {
    toast(err.message || 'Upload failed', 'error');
  }
});

// ─── Toolbar Buttons ──────────────────────────────────────────────────────────
document.getElementById('btn-upload').addEventListener('click', showUploadModal);
document.getElementById('btn-upload-empty')?.addEventListener('click', showUploadModal);

document.getElementById('btn-new-folder').addEventListener('click', () => {
  showModal(`
    <div class="modal-header"><h2>New Folder</h2><p>In: ${state.currentPath}</p></div>
    <div class="modal-body">
      <div class="field-row">
        <label>Folder Name</label>
        <input id="folder-name" type="text" placeholder="my-folder" autofocus />
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-gradient" id="create-folder">Create</button>
    </div>
  `);
  const inp = document.getElementById('folder-name');
  inp.focus();
  document.getElementById('create-folder').onclick = async () => {
    const name = inp.value.trim();
    if (!name) return;
    const r = await api.files.mkdir(pathJoin(state.currentPath, name));
    if (r && r.success) { toast(`Created "${name}"`, 'success'); closeModal(); await loadFiles(state.currentPath); }
    else toast(r?.error || 'Failed', 'error');
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('create-folder').click(); });
});

document.getElementById('btn-grid-view').addEventListener('click', () => {
  state.viewMode = 'grid';
  localStorage.setItem('viewMode', 'grid');
  renderGrid(state.files);
  document.getElementById('file-list').classList.add('hidden');
});

document.getElementById('btn-list-view').addEventListener('click', () => {
  state.viewMode = 'list';
  localStorage.setItem('viewMode', 'list');
  renderList(state.files);
  document.getElementById('file-grid').classList.add('hidden');
});

// Selection bar actions
document.getElementById('btn-sel-download').addEventListener('click', () => {
  state.selected.forEach(fp => window.open(api.files.downloadUrl(fp), '_blank'));
});
document.getElementById('btn-sel-delete').addEventListener('click', () => {
  const paths = Array.from(state.selected);
  confirmDelete(paths, paths.map(pathBasename));
});
document.getElementById('btn-sel-move').addEventListener('click', () => showMoveModal(Array.from(state.selected), 'move'));
document.getElementById('btn-sel-copy').addEventListener('click', () => showMoveModal(Array.from(state.selected), 'copy'));
document.getElementById('btn-sel-perms').addEventListener('click', () => showBulkPermissionsModal(Array.from(state.selected)));
document.getElementById('btn-sel-clear').addEventListener('click', clearSelection);

document.getElementById('btn-select-all').addEventListener('click', () => {
  const allSelected = state.files.every(f => state.selected.has(f.path));
  if (allSelected) {
    clearSelection();
  } else {
    state.files.forEach(f => state.selected.add(f.path));
    document.querySelectorAll('.file-card').forEach(c => c.classList.add('selected'));
    document.querySelectorAll('.row-check').forEach(c => { c.checked = true; c.closest('tr')?.classList.add('selected'); });
    const sa = document.getElementById('select-all');
    if (sa) sa.checked = true;
    updateSelectionBar();
  }
});

// ─── S3 View ──────────────────────────────────────────────────────────────────
async function loadS3View() {
  const cfg = await api.s3.getConfig();
  if (!cfg) return;

  if (!cfg.configured) {
    document.getElementById('s3-not-configured').classList.remove('hidden');
    document.getElementById('s3-container').classList.add('hidden');
  } else {
    document.getElementById('s3-not-configured').classList.add('hidden');
    state.s3Bucket = cfg.bucket;
    await loadS3(state.s3Prefix || '');
  }
}

async function loadS3(prefix) {
  state.s3Prefix = prefix;
  renderS3Breadcrumb(prefix);

  const container = document.getElementById('s3-container');
  const errBanner = document.getElementById('s3-error');
  container.classList.remove('hidden');
  errBanner.classList.add('hidden');
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  const data = await api.s3.list(prefix, state.s3Bucket, state.s3FlatMode);
  if (!data) return;

  // Show error if S3 returned one
  if (data.error) {
    container.innerHTML = '';
    errBanner.classList.remove('hidden');
    errBanner.innerHTML = `
      <div class="s3-error-icon">⚠</div>
      <div class="s3-error-body">
        <strong>S3 Error</strong>
        <code>${data.error}</code>
        <div class="s3-error-tips">
          <p>Common fixes for Ceph / MinIO:</p>
          <ul>
            <li>Enable <strong>Force Path Style</strong> in S3 config</li>
            <li>Check the <strong>Endpoint URL</strong> (e.g. <code>http://ceph-rgw:7480</code>)</li>
            <li>Verify <strong>Access Key</strong> and <strong>Secret Key</strong></li>
            <li>Confirm the <strong>Bucket name</strong> is correct</li>
            <li>Try switching to <strong>Flat List</strong> mode (button in toolbar)</li>
          </ul>
        </div>
        <button class="btn btn-sm" id="s3-open-cfg-from-err">Open S3 Config</button>
      </div>`;
    document.getElementById('s3-open-cfg-from-err')?.addEventListener('click', showS3ConfigModal);
    return;
  }

  const items = data.items || [];

  if (items.length === 0) {
    container.innerHTML = `
      <div class="file-empty">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        <p>No objects found in <strong>${state.s3Bucket}${prefix ? ' / ' + prefix : ''}</strong></p>
        <p style="font-size:12px;color:var(--text-light);margin-top:4px">
          ${state.s3FlatMode
            ? 'Bucket appears empty or the key prefix has no objects.'
            : 'No objects at this level. Try <strong>Flat List</strong> mode to see all keys.'}
        </p>
        ${!state.s3FlatMode ? `<button class="btn btn-sm" id="try-flat-btn">Switch to Flat List</button>` : ''}
      </div>`;
    document.getElementById('try-flat-btn')?.addEventListener('click', () => {
      state.s3FlatMode = true;
      updateS3FlatButton();
      loadS3('');
    });
    return;
  }

  const truncatedNote = data.truncated
    ? `<div class="s3-truncated-note">Showing first 1000 objects. Use a prefix to narrow results.</div>`
    : '';

  container.innerHTML = truncatedNote + items.map(item => {
    const cat = item.isDirectory ? 'dir' : mimeCategory(item.mimeType, item.name);
    const c = COLORS[cat] || '#9E9E9E';
    const icon = item.isDirectory
      ? `<svg viewBox="0 0 24 24" fill="${c}"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

    const escapedKey = item.key.replace(/"/g, '&quot;');
    return `<div class="file-card" data-key="${escapedKey}" data-isdir="${item.isDirectory}">
      <div class="file-card-icon">${icon}</div>
      <div class="file-card-name" title="${item.name}">${item.name}</div>
      <div class="file-card-meta">${item.isDirectory ? 'Folder' : fmtSize(item.size)}</div>
    </div>`;
  }).join('');

  container.querySelectorAll('.file-card').forEach(card => {
    const key = card.dataset.key;
    const isDir = card.dataset.isdir === 'true';
    const item = items.find(i => i.key === key);
    if (!item) return;

    card.addEventListener('click', () => {
      if (isDir) loadS3(key);
      else previewS3(item);
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const iconSvg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15">${p}</svg>`;
      const menuItems = isDir
        ? [{ label: 'Open', action: 'open', icon: iconSvg('<path d="M5 12h14M12 5l7 7-7 7"/>'), handler: () => loadS3(key) }]
        : [
            { label: 'Preview', action: 'preview', icon: iconSvg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'), handler: () => previewS3(item) },
            { label: 'Download', action: 'dl', icon: iconSvg('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>'), handler: () => window.open(api.s3.downloadUrl(key, state.s3Bucket), '_blank') },
            { label: 'Copy to PVC...', action: 'copy', icon: iconSvg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>'), handler: () => showS3CopyModal(item) },
          ];
      showContextMenu(e.clientX, e.clientY, menuItems);
    });
  });
}

function updateS3FlatButton() {
  const btn = document.getElementById('btn-s3-flat');
  if (!btn) return;
  if (state.s3FlatMode) {
    btn.classList.add('btn-gradient');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> Flat List`;
  } else {
    btn.classList.remove('btn-gradient');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> Tree View`;
  }
}

function renderS3Breadcrumb(prefix) {
  const bc = document.getElementById('s3-breadcrumb');
  const parts = prefix.replace(/\/$/, '').split('/').filter(Boolean);
  let html = `<span class="breadcrumb-item${prefix === '' ? ' active' : ''}" data-prefix="">⬡ ${state.s3Bucket}</span>`;
  let cum = '';
  parts.forEach((part, i) => {
    cum += part + '/';
    const isLast = i === parts.length - 1;
    html += `<span class="breadcrumb-sep">›</span><span class="breadcrumb-item${isLast ? ' active' : ''}" data-prefix="${cum}">${part}</span>`;
  });
  bc.innerHTML = html;
  bc.querySelectorAll('[data-prefix]').forEach(el => {
    if (!el.classList.contains('active')) {
      el.addEventListener('click', () => loadS3(el.dataset.prefix));
    }
  });
}

function previewS3(item) {
  const cat = mimeCategory(item.mimeType, item.name);
  const url = api.s3.previewUrl(item.key, state.s3Bucket);
  let content = '';

  if (cat === 'image') {
    content = `<div class="modal-header"><h2>${item.name}</h2><p>${fmtSize(item.size)} — S3</p></div>
      <div class="modal-body" style="text-align:center">
        <img class="preview-img" src="${url}" alt="${item.name}" />
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn" id="s3-copy-btn">Copy to PVC</button>
        <a class="btn btn-gradient" href="${api.s3.downloadUrl(item.key, state.s3Bucket)}" download="${item.name}">Download</a>
      </div>`;
    showModal(content, 'lg');
  } else if (cat === 'video') {
    content = `<div class="modal-header"><h2>${item.name}</h2></div>
      <div class="modal-body">
        <video class="preview-video" controls src="${url}">Not supported.</video>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn" id="s3-copy-btn">Copy to PVC</button>
        <a class="btn btn-gradient" href="${api.s3.downloadUrl(item.key, state.s3Bucket)}" download="${item.name}">Download</a>
      </div>`;
    showModal(content, 'lg');
  } else if (cat === 'text') {
    content = `<div class="modal-header"><h2>${item.name}</h2></div>
      <div class="modal-body">
        <div id="preview-code-wrap" class="preview-code"><div class="loading-spinner"><div class="spinner"></div></div></div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn" id="s3-copy-btn">Copy to PVC</button>
        <a class="btn btn-gradient" href="${api.s3.downloadUrl(item.key, state.s3Bucket)}" download="${item.name}">Download</a>
      </div>`;
    showModal(content, 'lg');
    fetch(url).then(r => r.text()).then(text => {
      const wrap = document.getElementById('preview-code-wrap');
      if (wrap) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = text.slice(0, 300000);
        pre.appendChild(code);
        wrap.innerHTML = '';
        wrap.appendChild(pre);
        hljs.highlightElement(code);
      }
    });
  } else {
    content = `<div class="modal-header"><h2>${item.name}</h2><p>${fmtSize(item.size)} — S3 Object</p></div>
      <div class="modal-body">
        <div class="info-card" style="border:none;padding:0">
          <div class="info-row"><span class="info-label">Key</span><span class="info-value" style="word-break:break-all">${item.key}</span></div>
          <div class="info-row"><span class="info-label">Bucket</span><span class="info-value">${state.s3Bucket}</span></div>
          <div class="info-row"><span class="info-label">Size</span><span class="info-value">${fmtSize(item.size)}</span></div>
          <div class="info-row"><span class="info-label">Modified</span><span class="info-value">${fmtDate(item.modified)}</span></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn" id="s3-copy-btn">Copy to PVC</button>
        <a class="btn btn-gradient" href="${api.s3.downloadUrl(item.key, state.s3Bucket)}" download="${item.name}">Download</a>
      </div>`;
    showModal(content);
  }

  setTimeout(() => {
    const btn = document.getElementById('s3-copy-btn');
    if (btn) btn.addEventListener('click', () => { closeModal(); showS3CopyModal(item); });
  }, 50);
}

function showS3CopyModal(item) {
  showModal(`
    <div class="modal-header"><h2>Copy to PVC</h2><p>${item.name}</p></div>
    <div class="modal-body">
      <div class="field-row">
        <label>Target PVC Path</label>
        <input id="s3-target-path" type="text" value="${state.currentPath}" placeholder="/destination/folder" />
        <div class="hint">Destination folder on PVC. File will be saved as: ${item.name}</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-gradient" id="confirm-s3-copy">Copy to PVC</button>
    </div>
  `);
  document.getElementById('confirm-s3-copy').onclick = async () => {
    const targetPath = document.getElementById('s3-target-path').value.trim();
    closeModal();
    toast(`Copying "${item.name}" to PVC...`, 'info');
    const r = await api.s3.copyToPvc(item.key, state.s3Bucket, targetPath);
    if (r && r.success) toast(`Copied to PVC: ${r.path}`, 'success');
    else toast(r?.error || 'Copy failed', 'error');
  };
}

// S3 Config Modal
function showS3ConfigModal() {
  api.s3.getConfig().then(cfg => {
    showModal(`
      <div class="modal-header"><h2>S3 Configuration</h2><p>Connect to S3-compatible storage (AWS, MinIO, Ceph, etc.)</p></div>
      <div class="modal-body">
        <div class="field-row">
          <label>Endpoint URL</label>
          <input id="s3-endpoint" type="text" value="${cfg?.endpoint || ''}" placeholder="https://s3.amazonaws.com or http://minio:9000" />
          <div class="hint">Leave empty for AWS S3. Set for MinIO or other S3-compatible.</div>
        </div>
        <div class="row-2">
          <div class="field-row">
            <label>Access Key ID</label>
            <input id="s3-ak" type="text" value="" placeholder="${cfg?.accessKeyId || 'AKIAIOSFODNN7EXAMPLE'}" autocomplete="off" />
          </div>
          <div class="field-row">
            <label>Secret Access Key</label>
            <input id="s3-sk" type="password" value="" placeholder="••••••••••••••••" autocomplete="off" />
          </div>
        </div>
        <div class="row-2">
          <div class="field-row">
            <label>Bucket Name</label>
            <input id="s3-bucket" type="text" value="${cfg?.bucket || ''}" placeholder="my-bucket" />
          </div>
          <div class="field-row">
            <label>Region</label>
            <input id="s3-region" type="text" value="${cfg?.region || 'us-east-1'}" placeholder="us-east-1" />
          </div>
        </div>
        <div class="checkbox-row">
          <input type="checkbox" id="s3-path-style" ${cfg?.forcePathStyle ? 'checked' : ''} />
          <label for="s3-path-style">Force Path Style (required for MinIO / self-hosted)</label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-gradient" id="save-s3-cfg">Save & Connect</button>
      </div>
    `);

    document.getElementById('save-s3-cfg').onclick = async () => {
      const ak = document.getElementById('s3-ak').value.trim();
      const sk = document.getElementById('s3-sk').value.trim();
      const body = {
        endpoint: document.getElementById('s3-endpoint').value.trim(),
        accessKeyId: ak || (cfg?.accessKeyId || ''),
        secretAccessKey: sk || (cfg?.secretAccessKey || ''),
        bucket: document.getElementById('s3-bucket').value.trim(),
        region: document.getElementById('s3-region').value.trim() || 'us-east-1',
        forcePathStyle: document.getElementById('s3-path-style').checked,
      };
      const r = await api.s3.saveConfig(body);
      if (r && r.success) {
        toast('S3 configured successfully', 'success');
        closeModal();
        loadS3View();
      } else {
        toast(r?.error || 'Save failed', 'error');
      }
    };
  });
}

document.getElementById('btn-s3-config').addEventListener('click', showS3ConfigModal);
document.getElementById('btn-s3-config-2').addEventListener('click', showS3ConfigModal);
document.getElementById('btn-s3-refresh').addEventListener('click', () => loadS3(state.s3Prefix));
document.getElementById('btn-s3-flat').addEventListener('click', () => {
  state.s3FlatMode = !state.s3FlatMode;
  updateS3FlatButton();
  loadS3('');
});

// ─── System Info View ─────────────────────────────────────────────────────────
async function loadSystemView() {
  const content = document.getElementById('system-info-content');
  content.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  const info = await api.system.info();
  if (!info) return;

  const cmds = info.commands;
  const cmdItem = (label, cmd) => `
    <div class="cmd-item">
      <div class="cmd-code">${label}: <strong>${cmd}</strong></div>
      <button class="cmd-copy" onclick="navigator.clipboard.writeText('${cmd.replace(/'/g, "\\'")}').then(()=>toast('Copied!','success'))">Copy</button>
    </div>`;

  content.innerHTML = `
    <div class="info-grid">
      <div class="info-card">
        <h3>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 10-16 0"/></svg>
          Process Identity
        </h3>
        <div class="info-row"><span class="info-label">UID</span><span class="info-value info-badge grad">${info.uid}</span></div>
        <div class="info-row"><span class="info-label">GID</span><span class="info-value info-badge grad">${info.gid}</span></div>
        <div style="padding:8px 0">
          <div class="info-label" style="margin-bottom:6px">id output</div>
          <code style="display:block;background:#1a1a2e;color:#e8e8f0;padding:8px 10px;border-radius:8px;font-size:11px;word-break:break-all;white-space:pre-wrap;line-height:1.6">${info.idOutput}</code>
        </div>
      </div>

      <div class="info-card">
        <h3>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
          Storage
        </h3>
        <div class="info-row"><span class="info-label">Data Path</span><span class="info-value" style="font-size:12px;word-break:break-all">${info.dataPath}</span></div>
      </div>

      <div class="info-card" style="grid-column:1/-1">
        <h3>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          Useful Commands
        </h3>
        <div class="hint" style="margin-bottom:12px">Run these in a terminal to get UID/GID values for configuring file permissions.</div>
        <div class="cmd-list">
          ${cmdItem('Get current user ID & GID', cmds.getCurrentUser)}
          ${cmdItem('Get file UID, GID, permissions', cmds.getFileOwner)}
          ${cmdItem('List files with UID/GID', cmds.listWithOwners)}
          ${cmdItem('Find files by UID', cmds.findByUid)}
          ${cmdItem('Find files by GID', cmds.findByGid)}
          ${cmdItem('Change owner recursively', cmds.changeOwner)}
          ${cmdItem('Make all files writable', cmds.changeMode)}
          ${cmdItem('Set 777 on all files', cmds.setAllPermissions)}
        </div>
      </div>

      <div class="info-card" style="grid-column:1/-1">
        <h3>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          Permission Quick Reference
        </h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-top:4px">
          ${[
            ['777', 'rwxrwxrwx', 'All can read/write/execute', '#E1306C'],
            ['755', 'rwxr-xr-x', 'Owner full, others read+exec', '#F77737'],
            ['644', 'rw-r--r--', 'Owner write, others read only', '#FCAF45'],
            ['600', 'rw-------', 'Owner only (secrets)', '#833AB4'],
            ['700', 'rwx------', 'Owner only with execute', '#833AB4'],
          ].map(([mode, rwx, desc, color]) => `
            <div style="background:var(--bg);border-radius:8px;padding:10px 12px;border:1.5px solid var(--border)">
              <div style="font-size:18px;font-weight:800;color:${color};font-family:monospace">${mode}</div>
              <div style="font-family:monospace;font-size:11px;color:var(--text-light);margin:2px 0">${rwx}</div>
              <div style="font-size:12px;color:var(--text)">${desc}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function startApp() {
  showApp();
  await loadVolumes();
  await navigateTo('/');
}

async function init() {
  await loadConfig();
  try {
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null);
    if (me && me.username) {
      state.authenticated = true;
      state.username = me.username;
      await startApp();
      return;
    }
  } catch {}
  showLogin();
}

init();
