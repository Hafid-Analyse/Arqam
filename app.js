'use strict';

/* =====================================================================
 * أرقام وعناوين — واجهة PWA (تتصل بـ Google Apps Script كـ API)
 * ===================================================================== */

const LS = {
  session: 'rep_session_v2',   // {name, code, role}
  data: 'data_cache_v2',       // {name, ts, data}
  reps: 'reps_cache_v1',       // [أسماء المناديب]
  ui: 'ui_state',              // {tab, region, search}
  fab: 'fab_pos',
  dark: 'dark_mode'
};

let ALL_DATA = { clients: [], transport: [], hotels: [], regionColors: {} };
let currentTab = 'clients';
let currentRegion = null;      // للزبائن (region) وللفنادق (wilaya)
let searchTerm = '';
let SESSION = null;            // {name, code, role}
let hasData = false;
let lastRefresh = 0;
let refreshing = false;
let deferredInstall = null;

const $ = id => document.getElementById(id);

/* ---------------- تخزين محلي آمن ---------------- */
function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) { return fallback; }
}
function lsSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }
function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

/* ---------------- أدوات أمان للعرض ---------------- */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function safeUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : '';
  } catch (e) { return ''; }
}
function safeColor(c) {
  c = String(c || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
  if (/^[a-zA-Z]{3,20}$/.test(c)) return c;
  return '';
}

/* ---------------- الاتصال بالـ API ---------------- */
async function apiPost(payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  try {
    // نص عادي (بدون Content-Type) لتجنب preflight مع Apps Script
    const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(payload), signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function apiGet(params) {
  const url = API_URL + (API_URL.indexOf('?') === -1 ? '?' : '&') + new URLSearchParams(params);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function apiConfigured() {
  return typeof API_URL === 'string' && /^https:\/\/script\.google\.com\//.test(API_URL);
}

/* =====================================================================
 * تسجيل الدخول
 * ===================================================================== */
async function doLogin() {
  const name = $('login-name').value.trim();
  const code = $('login-code').value.trim();
  const errEl = $('login-error');
  errEl.textContent = '';
  if (!name || !code) { errEl.textContent = 'الرجاء اختيار الاسم وإدخال الكود'; return; }
  if (!apiConfigured()) { errEl.textContent = 'لم يُضبط رابط الخادم في config.js'; return; }

  const btn = $('login-btn');
  btn.disabled = true; btn.textContent = 'جارِ التحقق...';
  try {
    const res = await apiPost({ action: 'login', name: name, code: code });
    if (res.ok) {
      SESSION = { name: res.user.name, code: code, role: res.user.role };
      lsSet(LS.session, SESSION);
      lsDel(LS.data);
      hasData = false;
      enterApp();
    } else {
      errEl.textContent = res.message || 'تعذّر تسجيل الدخول';
    }
  } catch (e) {
    errEl.textContent = 'تعذّر الاتصال بالخادم، تحقق من الإنترنت';
  } finally {
    btn.disabled = false; btn.textContent = 'دخول';
  }
}

function logout(message) {
  lsDel(LS.session);
  lsDel(LS.data);
  lsDel(LS.ui);
  SESSION = null;
  hasData = false;
  currentTab = 'clients';
  currentRegion = null;
  searchTerm = '';
  $('search-input').value = '';
  updateFabIcon();
  syncTabUi_();
  ALL_DATA = { clients: [], transport: [], hotels: [], regionColors: {} };
  $('app-screen').style.display = 'none';
  $('login-screen').style.display = 'flex';
  $('search-fab').style.display = 'none';
  $('search-panel').style.display = 'none';
  $('login-code').value = '';
  $('login-error').textContent = typeof message === 'string' ? message : '';
  loadRepNames();
}

/* قائمة الأسماء المنسدلة: من الذاكرة فورًا ثم تحديث من الخادم */
function fillRepSelect(names) {
  const select = $('login-name');
  const current = select.value;
  select.innerHTML = '<option value="">-- اختر اسمك --</option>' +
    names.map(n => '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>').join('');
  if (current && names.indexOf(current) !== -1) select.value = current;
}

async function loadRepNames() {
  const cached = lsGet(LS.reps, null);
  if (cached) fillRepSelect(cached);
  if (!apiConfigured()) {
    if (!cached) $('login-error').textContent = 'لم يُضبط رابط الخادم في config.js';
    return;
  }
  try {
    const res = await apiGet({ action: 'reps' });
    if (res.ok && Array.isArray(res.names)) {
      lsSet(LS.reps, res.names);
      fillRepSelect(res.names);
    }
  } catch (e) {
    if (!cached) $('login-error').textContent = 'تعذّر تحميل أسماء المناديب، تحقق من الإنترنت';
  }
}

/* =====================================================================
 * الدخول إلى التطبيق وتحميل البيانات
 * ===================================================================== */
function enterApp() {
  $('login-screen').style.display = 'none';
  $('app-screen').style.display = 'block';
  $('rep-name-display').textContent = SESSION.name;
  $('search-fab').style.display = 'flex';

  restoreUiState_();
  applyRolePermissions_();
  syncTabUi_();

  const cached = lsGet(LS.data, null);
  if (cached && cached.name === SESSION.name && cached.data) {
    ALL_DATA = normalizeData_(cached.data);
    hasData = true;
    afterDataLoaded_();
  } else {
    $('list-container').innerHTML = '<div class="empty-state">جارِ تحميل البيانات...</div>';
  }
  refreshData();
}

function normalizeData_(d) {
  return {
    clients: d.clients || [],
    transport: d.transport || [],
    hotels: d.hotels || [],
    regionColors: d.regionColors || {}
  };
}

function setStatus(text) {
  const bar = $('status-bar');
  bar.textContent = text || '';
  bar.classList.toggle('show', !!text);
}

async function refreshData() {
  if (!SESSION || refreshing) return;
  refreshing = true;
  if (hasData) setStatus('جارِ تحديث البيانات...');
  try {
    const res = await apiPost({ action: 'data', name: SESSION.name, code: SESSION.code });
    if (!res.ok) {
      if (res.error === 'auth' || res.error === 'inactive') { logout(res.message); return; }
      throw new Error(res.message || 'server');
    }
    SESSION.role = res.user.role;
    lsSet(LS.session, SESSION);
    ALL_DATA = normalizeData_(res);
    hasData = true;
    lastRefresh = Date.now();
    lsSet(LS.data, { name: SESSION.name, ts: res.ts, data: ALL_DATA });
    setStatus('');
    applyRolePermissions_();
    syncTabUi_();
    afterDataLoaded_();
  } catch (e) {
    if (hasData) {
      setStatus('⚠️ غير متصل — تُعرض آخر بيانات محفوظة');
    } else {
      setStatus('');
      $('list-container').innerHTML =
        '<div class="empty-state">تعذّر تحميل البيانات.<br>تحقق من الإنترنت ثم أعد المحاولة.<br>' +
        '<button class="retry-btn" id="retry-btn">إعادة المحاولة</button></div>';
    }
  } finally {
    refreshing = false;
  }
}

function afterDataLoaded_() {
  buildRegionFilter();
  buildNameSuggestions();
  renderList();
}

/* مسؤول المخزن لا يرى الفنادق */
function applyRolePermissions_() {
  const hideHotels = SESSION && SESSION.role === 'مخزن';
  document.querySelector('.tab-btn[data-tab="hotels"]').style.display = hideHotels ? 'none' : '';
  if (hideHotels && currentTab === 'hotels') {
    currentTab = 'clients';
    currentRegion = null;
  }
}

function syncTabUi_() {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  $('region-filter').style.display = (currentTab === 'transport') ? 'none' : 'flex';
}

/* =====================================================================
 * حفظ/استرجاع حالة الواجهة
 * ===================================================================== */
function saveUiState_() {
  lsSet(LS.ui, { tab: currentTab, region: currentRegion, search: searchTerm });
}

function restoreUiState_() {
  const saved = lsGet(LS.ui, null);
  if (!saved) return;
  currentTab = saved.tab || 'clients';
  currentRegion = saved.region || null;
  searchTerm = saved.search || '';
  $('search-input').value = searchTerm;
  updateFabIcon();
}

/* =====================================================================
 * التبويبات والفلاتر
 * ===================================================================== */
function switchTab(tab) {
  currentTab = tab;
  currentRegion = null;
  searchTerm = '';
  $('search-input').value = '';
  updateFabIcon();
  syncTabUi_();
  buildRegionFilter();
  buildNameSuggestions();
  saveUiState_();
  renderList();
}

/* فلتر المناطق: region للزبائن، wilaya للفنادق، لا يظهر للنقل */
function fieldForTab_() {
  if (currentTab === 'clients') return 'region';
  if (currentTab === 'hotels') return 'wilaya';
  return null;
}

function scopedItems_() {
  return ALL_DATA[currentTab] || [];
}

function regionColor_(region) {
  return safeColor(ALL_DATA.regionColors && ALL_DATA.regionColors[region]);
}

function regionDot_(region) {
  const color = regionColor_(region);
  return color ? '<span class="region-dot" style="background:' + color + '"></span>' : '';
}

function buildRegionFilter() {
  const field = fieldForTab_();
  const container = $('region-filter');
  if (!field) { container.innerHTML = ''; return; }
  const values = [...new Set(scopedItems_().map(it => it[field]).filter(Boolean))].sort();
  if (currentRegion && values.indexOf(currentRegion) === -1) currentRegion = null;
  const colorFor = field === 'region' ? regionDot_ : () => '';
  container.innerHTML =
    '<div class="pill ' + (currentRegion === null ? 'active' : '') + '" data-value="">الكل</div>' +
    values.map(v =>
      '<div class="pill ' + (currentRegion === v ? 'active' : '') + '" data-value="' + escapeHtml(v) + '">' +
      colorFor(v) + escapeHtml(v) + '</div>'
    ).join('');
}

function selectRegion(v) {
  currentRegion = v;
  buildRegionFilter();
  saveUiState_();
  renderList();
}

/* =====================================================================
 * البحث (بالاسم فقط)
 * ===================================================================== */
function toggleSearch() {
  const panel = $('search-panel');
  const isOpen = panel.style.display === 'flex';
  if (isOpen) {
    commitSearch();
  } else if (searchTerm) {
    clearSearch();
  } else {
    panel.style.display = 'flex';
    $('search-input').focus();
  }
}

function applySearch() {
  searchTerm = $('search-input').value.trim().toLowerCase();
  renderList();
}

function commitSearch() {
  $('search-panel').style.display = 'none';
  updateFabIcon();
  saveUiState_();
}

function clearSearch() {
  searchTerm = '';
  $('search-input').value = '';
  updateFabIcon();
  saveUiState_();
  renderList();
}

function updateFabIcon() {
  $('search-fab').textContent = searchTerm ? '✖' : '🔍';
}

function buildNameSuggestions() {
  const names = [...new Set(scopedItems_().map(it => it.name || it.label).filter(Boolean))].sort();
  $('name-suggestions').innerHTML = names.map(n => '<option value="' + escapeHtml(n) + '">').join('');
}

/* الزر العائم: سحب سلس + حفظ الموضع */
function initFabPosition() {
  const fab = $('search-fab');
  const size = 54;
  const clamp = (x, y) => ({
    x: Math.min(Math.max(0, x), window.innerWidth - size),
    y: Math.min(Math.max(0, y), window.innerHeight - size)
  });

  let pos = clamp.apply(null, (() => {
    const s = lsGet(LS.fab, null);
    return s ? [s.x, s.y] : [window.innerWidth - 74, window.innerHeight - 130];
  })());
  setFabPosition(pos.x, pos.y);

  let dragging = false, moved = false, startX = 0, startY = 0, rafId = null, pending = pos;

  fab.addEventListener('pointerdown', e => {
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    fab.setPointerCapture(e.pointerId);
    fab.style.cursor = 'grabbing';
  });

  fab.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
    if (!moved) return;
    pending = clamp(pos.x + dx, pos.y + dy);
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        setFabPosition(pending.x, pending.y);
        rafId = null;
      });
    }
  });

  fab.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    fab.style.cursor = 'grab';
    if (moved) {
      pos = pending;
      lsSet(LS.fab, pos);
    } else {
      toggleSearch();
    }
  });

  fab.addEventListener('pointercancel', () => { dragging = false; });

  window.addEventListener('resize', () => {
    pos = clamp(pos.x, pos.y);
    setFabPosition(pos.x, pos.y);
  });
}

function setFabPosition(x, y) {
  const fab = $('search-fab');
  const panel = $('search-panel');
  fab.style.left = x + 'px';
  fab.style.top = y + 'px';
  panel.style.top = y + 'px';
  if (x < window.innerWidth / 2) { panel.style.left = (x + 62) + 'px'; }
  else { panel.style.left = (x - 190) + 'px'; }
  panel.style.right = 'auto';
}

/* =====================================================================
 * عرض البطاقات
 * ===================================================================== */
function currentFilteredItems_() {
  let items = scopedItems_();
  const field = fieldForTab_();
  if (field && currentRegion) {
    items = items.filter(it => it[field] === currentRegion);
  }
  if (searchTerm) {
    items = items.filter(it => (it.name || it.label || '').toLowerCase().indexOf(searchTerm) !== -1);
  }
  return items;
}

function renderList() {
  const container = $('list-container');
  const items = currentFilteredItems_();
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state">' + (hasData ? 'لا توجد نتائج' : 'جارِ تحميل البيانات...') + '</div>';
    return;
  }
  container.innerHTML = items.map(renderCard).join('');
}

function renderCard(it, idx) {
  const title = it.name || it.label || '';
  let sub = '';
  let cardStyle = '';
  if (currentTab === 'clients') {
    sub = (it.region ? regionDot_(it.region) : '') + escapeHtml(it.region || '');
    const color = regionColor_(it.region);
    if (color) cardStyle = ' style="border-right-color:' + color + '"';
  }
  if (currentTab === 'hotels') sub = escapeHtml([it.type, it.wilaya].filter(Boolean).join(' • '));

  const phoneLine = it.phone
    ? '<div class="card-phone" data-phone="' + escapeHtml(it.phone) + '">📱 ' + escapeHtml(it.phone) +
      ' <span class="copy-hint">نسخ</span></div>'
    : '';

  const href = safeUrl(it.mapLink);
  const mapBtn = href
    ? '<a class="action-btn map" href="' + escapeHtml(href) + '" target="_blank" rel="noopener">📍 الخريطة</a>'
    : '<span class="action-btn map missing">📍 لا يوجد</span>';

  return '<div class="card"' + cardStyle + '>' +
    '<div class="card-title">' + escapeHtml(title) + '</div>' +
    (sub ? '<div class="card-sub">' + sub + '</div>' : '') +
    phoneLine +
    '<div class="card-actions">' +
      mapBtn +
      '<button class="action-btn details" data-idx="' + idx + '">ℹ️ تفاصيل</button>' +
    '</div>' +
  '</div>';
}

/* نسخ رقم الهاتف بضغطة واحدة */
function copyPhone(el, phone) {
  const finish = () => {
    const hint = el.querySelector('.copy-hint');
    if (!hint) return;
    const old = hint.textContent;
    hint.textContent = '✔ تم النسخ';
    setTimeout(() => { hint.textContent = old; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(phone).then(finish).catch(finish);
  } else {
    const ta = document.createElement('textarea');
    ta.value = phone;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    finish();
  }
}

/* =====================================================================
 * نافذة التفاصيل
 * ===================================================================== */
function showDetails(idx) {
  const it = currentFilteredItems_()[idx];
  if (!it) return;

  const rows = [];
  if (currentTab === 'clients') {
    rows.push(['اسم الزبون', it.name]);
    rows.push(['المنطقة', it.region]);
    if (it.ville) rows.push(['المدينة', it.ville]);
    if (it.wilaya) rows.push(['الولاية', it.wilaya]);
    rows.push(['الهاتف', it.phone || '—']);
  } else if (currentTab === 'transport') {
    rows.push(['اسم الشركة', it.name]);
    rows.push(['الهاتف', it.phone || '—']);
  } else {
    rows.push(['النوع', it.type]);
    rows.push(['الولاية', it.wilaya]);
    rows.push(['الهاتف', it.phone || '—']);
  }

  $('details-title').textContent = it.name || it.label;
  $('details-body').innerHTML = rows
    .map(r => '<div class="detail-row"><span>' + escapeHtml(r[0]) + '</span><span>' + escapeHtml(r[1] || '—') + '</span></div>')
    .join('');
  $('details-overlay').style.display = 'flex';
}

function closeDetails() { $('details-overlay').style.display = 'none'; }

/* =====================================================================
 * الوضع الليلي والتثبيت
 * ===================================================================== */
function applyDarkModePref_() {
  const on = lsGet(LS.dark, false) === true;
  document.body.classList.toggle('dark-mode', on);
  $('dark-toggle').textContent = on ? '☀️' : '🌙';
}

function toggleDarkMode() {
  lsSet(LS.dark, !document.body.classList.contains('dark-mode'));
  applyDarkModePref_();
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  $('install-btn').style.display = 'inline-block';
  $('install-btn-login').style.display = 'block';
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  $('install-btn').style.display = 'none';
  $('install-btn-login').style.display = 'none';
});

async function installApp() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch (e) {}
  deferredInstall = null;
  $('install-btn').style.display = 'none';
  $('install-btn-login').style.display = 'none';
}

/* =====================================================================
 * بدء التشغيل
 * ===================================================================== */
window.addEventListener('load', () => {
  applyDarkModePref_();
  initFabPosition();

  // أحداث ديناميكية (تفويض)
  $('region-filter').addEventListener('click', e => {
    const pill = e.target.closest('.pill');
    if (pill) selectRegion(pill.dataset.value || null);
  });

  $('list-container').addEventListener('click', e => {
    const phone = e.target.closest('.card-phone');
    if (phone) { copyPhone(phone, phone.dataset.phone); return; }
    const det = e.target.closest('.action-btn.details');
    if (det) { showDetails(parseInt(det.dataset.idx, 10)); return; }
    if (e.target.closest('#retry-btn')) refreshData();
  });

  $('details-overlay').addEventListener('click', e => {
    if (e.target.id === 'details-overlay') closeDetails();
  });

  $('search-input').addEventListener('input', applySearch);
  $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') commitSearch(); });
  $('login-code').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // تحديث البيانات عند العودة للتطبيق أو عودة الإنترنت
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && SESSION && Date.now() - lastRefresh > 120000) refreshData();
  });
  window.addEventListener('online', () => { if (SESSION) refreshData(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  SESSION = lsGet(LS.session, null);
  if (SESSION && SESSION.name && SESSION.code) {
    enterApp();
  } else {
    SESSION = null;
    loadRepNames();
  }
});
