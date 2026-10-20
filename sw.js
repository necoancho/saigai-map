// オフライン対応：アプリ本体と、一度表示した地図タイルを端末に保存する
const APP = 'saigai-app-v4';
const TILES = 'saigai-tiles-v1';
const TILE_LIMIT = 3000;
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'lib/leaflet/leaflet.css', 'lib/leaflet/leaflet.js', 'lib/leaflet/images/marker-icon.png', 'lib/leaflet/images/marker-icon-2x.png', 'lib/leaflet/images/marker-shadow.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== APP && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function trimTiles(){
  const c = await caches.open(TILES); const ks = await c.keys();
  for (let i = 0; i < ks.length - TILE_LIMIT; i++) await c.delete(ks[i]);
}
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebase の通信はキャッシュしない（Firestore が自前でオフライン対応する）
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('firebaseio.com')) return;
  // 地図タイル：保存済みを優先、なければ取得して保存
  if (url.hostname === 'cyberjapandata.gsi.go.jp'){
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok){ c.put(req, res.clone()); trimTiles(); } return res; }
      catch { return new Response('', {status: 504}); }
    }));
    return;
  }
  // アプリ本体・ライブラリ：通信できれば最新、できなければ保存済み
  // 自サイトのファイルはブラウザのキャッシュを使わず、必ず最新を確認する
  const net = url.origin === location.origin ? fetch(req, {cache: 'no-cache'}) : fetch(req);
  e.respondWith(net.then(res => {
    if (res.ok && (url.origin === location.origin || url.hostname === 'www.gstatic.com')){
      const copy = res.clone(); caches.open(APP).then(c => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
