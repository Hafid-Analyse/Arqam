/* Service Worker — أرقام وعناوين
 * ملفات الواجهة: الشبكة أولًا (مع مهلة 3.5 ثانية) ثم النسخة المحفوظة عند انقطاع الإنترنت.
 * طلبات الـ API (Google) لا يعترضها؛ التطبيق نفسه يحفظ آخر بيانات في الجهاز.
 * عند تعديل أي ملف واجهة يكفي رفعه؛ غيّر رقم CACHE فقط لو أردت إجبار تنظيف الكاش القديم.
 */
const CACHE = 'arqam-v2';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', event => {
  // كل ملف يُضاف على حدة: غياب ملف واحد (مثل أيقونة لم تُرفع) لا يُفشل تثبيت الـ service worker
  event.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // لا نتدخل في طلبات Google
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch(req.url, { cache: 'no-cache', signal: ctrl.signal });
    clearTimeout(timer);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    clearTimeout(timer);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}
