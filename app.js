import { FIREBASE_CONFIG, MAP } from './config.js';

/* =========================================================
   定数
   ========================================================= */
const CATS = [
  {k:'flood', label:'浸水・冠水', g:'水'},
  {k:'river', label:'河川の増水・越水', g:'川'},
  {k:'slide', label:'土砂崩れ・崖崩れ', g:'土'},
  {k:'road',  label:'道路の通行止め・損壊', g:'道'},
  {k:'bldg',  label:'建物・家屋の被害', g:'家'},
  {k:'life',  label:'停電・断水・通信障害', g:'電'},
  {k:'evac',  label:'避難・安否', g:'避'},
  {k:'other', label:'その他', g:'他'},
];
const LEVELS = [
  {k:'urgent', label:'緊急', sub:'人命・避難に関わる'},
  {k:'caution', label:'注意', sub:'通行や生活に支障'},
  {k:'info', label:'情報', sub:'参考情報'},
];
const catOf = k => CATS.find(c => c.k === k) || CATS[CATS.length - 1];
const lvOf = k => LEVELS.find(l => l.k === k) || LEVELS[2];
const GSI_URL = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">出典：国土地理院</a>';
const LS = {code:'saigai.code', name:'saigai.name', local:'saigai.localReports'};

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

/* =========================================================
   状態
   ========================================================= */
let store = null;            // 保存先（Firebase か 端末内）
let reports = [];
let gps = null;              // 最新の現在地 {lat,lng,acc,time}
let gpsError = null;
let draft = null;            // 入力中の投稿 {photo, thumb, lat, lng, acc, moved}
let showDone = false, filterCats = new Set(), selected = null;
let stream = null;

/* =========================================================
   ユーティリティ
   ========================================================= */
let toastTimer;
function toast(msg, ms = 3200){ const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms); }
const fmtTime = ms => {
  if (!ms) return '';
  return new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(new Date(ms));
};
const relTime = ms => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'たった今'; if (m < 60) return m + '分前';
  const h = Math.round(m / 60); if (h < 24) return h + '時間前';
  return Math.round(h / 24) + '日前';
};
function pinEl(r, extra = ''){
  return el('span', `pin c-${catOf(r.cat).k} ${r.level || 'info'}${r.status === 'resolved' ? ' resolved' : ''}${r.pending ? ' pending' : ''}${extra}`, catOf(r.cat).g);
}
function distM(a, b){
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function areaBounds(scale = 1){
  const [lat, lng] = MAP.center; const r = MAP.radiusMeters * scale;
  const dLat = r / 111000, dLng = r / (111320 * Math.cos(lat * Math.PI / 180));
  return L.latLngBounds([lat - dLat, lng - dLng], [lat + dLat, lng + dLng]);
}
function show(id){
  ['scr-camera', 'scr-form', 'scr-map'].forEach(s => $(s).hidden = s !== id);
  if (id === 'scr-camera') startCamera(); else stopCamera();
  if (id === 'scr-map') setTimeout(() => { barH(); bigmap && bigmap.invalidateSize(); }, 50);
  if (id === 'scr-form') setTimeout(() => minimap && minimap.invalidateSize(), 50);
}

/* =========================================================
   画像
   ========================================================= */
function drawScaled(src, w0, h0, max, q){
  const sc = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * sc); c.height = Math.round(h0 * sc);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
function makeImages(src, w, h){
  return { photo: drawScaled(src, w, h, 1280, 0.72), thumb: drawScaled(src, w, h, 240, 0.6) };
}
async function fromFile(file){
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    return { imgs: makeImages(img, img.naturalWidth, img.naturalHeight), exif: await readExifGps(file) };
  } finally { URL.revokeObjectURL(url); }
}
// 写真に埋め込まれた位置情報（EXIF GPS）を読む。なければ null
async function readExifGps(file){
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o < v.byteLength - 4){
      const marker = v.getUint16(o); const len = v.getUint16(o + 2);
      if (marker === 0xFFE1 && v.getUint32(o + 4) === 0x45786966){
        const t = o + 10; const le = v.getUint16(t) === 0x4949;
        const u16 = p => v.getUint16(p, le), u32 = p => v.getUint32(p, le);
        const ifd0 = t + u32(t + 4); let gpsOff = null;
        for (let i = 0, n = u16(ifd0); i < n; i++){ const e = ifd0 + 2 + i * 12; if (u16(e) === 0x8825) gpsOff = t + u32(e + 8); }
        if (gpsOff == null) return null;
        const tags = {};
        for (let i = 0, n = u16(gpsOff); i < n; i++){
          const e = gpsOff + 2 + i * 12; const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
          if (type === 2) tags[tag] = String.fromCharCode(v.getUint8(cnt <= 4 ? e + 8 : t + u32(e + 8)));
          if (type === 5){ const p = t + u32(e + 8); tags[tag] = [0, 1, 2].map(k => u32(p + k * 8) / u32(p + k * 8 + 4)); }
        }
        if (!tags[2] || !tags[4]) return null;
        const dms = a => a[0] + a[1] / 60 + a[2] / 3600;
        let lat = dms(tags[2]), lng = dms(tags[4]);
        if (tags[1] === 'S') lat = -lat; if (tags[3] === 'W') lng = -lng;
        if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return null;
        return {lat, lng};
      }
      o += 2 + len;
    }
  } catch {}
  return null;
}

/* =========================================================
   位置情報
   ========================================================= */
let gpsWatch = null, gpsCode = 0;
const GPS_MSG = {
  0: '位置を取得中…',
  1: '位置情報が許可されていません',
  2: '位置を特定できません',
  3: '位置の取得に時間がかかっています',
  9: 'この端末では位置情報を使えません',
  8: 'https で開いていないため位置情報を使えません',
};
function onPos(p){
  gps = {lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), time: p.timestamp};
  gpsError = null; gpsCode = 0; renderGps(); onGpsForDraft(); updateMeMarker();
}
function onPosErr(e){
  if (gps && Date.now() - gps.time < 120000) return; // 直前の位置が新しければそのまま使う
  gpsCode = e.code || 2; gpsError = GPS_MSG[gpsCode] || GPS_MSG[2]; renderGps();
  // 高精度で取れないときは、精度を落として1回試す
  if (gpsCode !== 1) navigator.geolocation.getCurrentPosition(onPos, () => {}, {enableHighAccuracy: false, maximumAge: 60000, timeout: 20000});
}
function startGps(){
  if (!window.isSecureContext){ gpsCode = 8; gpsError = GPS_MSG[8]; renderGps(); return; }
  if (!('geolocation' in navigator)){ gpsCode = 9; gpsError = GPS_MSG[9]; renderGps(); return; }
  if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = navigator.geolocation.watchPosition(onPos, onPosErr, {enableHighAccuracy: true, maximumAge: 10000, timeout: 30000});
}
// ボタン操作から呼ぶ再取得（iPhone は操作をきっかけにすると許可の確認が出やすい）
function retryGps(){
  gpsCode = 0; gpsError = null; renderGps();
  navigator.geolocation.getCurrentPosition(p => { onPos(p); startGps(); }, e => { onPosErr(e); openGpsHelp(); }, {enableHighAccuracy: true, maximumAge: 0, timeout: 20000});
}
function renderGps(){
  const chip = $('gps-chip'), t = $('gps-text');
  chip.classList.remove('ok', 'bad');
  if (gps && !gpsError){ chip.classList.add('ok'); t.textContent = `位置OK（誤差 約${gps.acc}m）`; }
  else if (gpsError){ chip.classList.add('bad'); t.textContent = gpsError + '（タップで対処法）'; }
  else t.textContent = GPS_MSG[0];
  if (draft) renderLocNote();
}
function openGpsHelp(){
  const box = $('gps-help-body'); box.textContent = '';
  const add = (tag, text) => box.append(el(tag, null, text));
  add('p', '現在の状態：' + (gpsError || (gps ? `取得できています（誤差 約${gps.acc}m）` : GPS_MSG[0])));
  if (gpsCode === 1){
    add('h3', 'iPhone の場合');
    const ol = el('ol');
    ['「設定」アプリ →「プライバシーとセキュリティ」→「位置情報サービス」をオンにする',
     '同じ画面の下の方にある「Safari Webサイト」を開き、「使用中」などの許可する設定にする（「なし」だと使えません）',
     'Safari でこのページを開き、アドレスバー左の表示（「ぁあ」など）から Web サイトの設定を開き、「位置情報」を「許可」または「確認」にする',
     'このアプリを一度閉じて、もう一度開く'].forEach(x => ol.append(el('li', null, x)));
    box.append(ol);
    add('h3', 'Android の場合');
    add('p', 'Chrome でこのページを開き、アドレスバー左のアイコン →「権限」→「位置情報」を許可にしてください。');
  } else if (gpsCode === 8){
    add('p', 'アドレスが https:// で始まるページで開いてください。');
  } else {
    add('p', '屋内や建物のかげでは、取得に時間がかかったり、できなかったりします。屋外の空が見える場所で「もう一度試す」を押してください。');
    add('p', '取得できない場合でも、入力画面の地図をタップすれば位置を指定して投稿できます。');
  }
  $('gps-help').hidden = false;
}

/* =========================================================
   カメラ
   ========================================================= */
async function startCamera(){
  if (stream) return;
  const v = $('video');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ camFallback('この端末ではアプリ内のカメラを使えません。'); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1440}}, audio: false});
    if ($('scr-camera').hidden){ stopCamera(); return; }
    v.srcObject = stream; await v.play().catch(() => {});
    $('cam-fallback').hidden = true; v.hidden = false;
  } catch (e) {
    camFallback(e && e.name === 'NotAllowedError' ? 'カメラの利用が許可されていません。下のボタンから撮影できます。' : 'カメラを開けませんでした。下のボタンから撮影できます。');
  }
}
function stopCamera(){ if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; } }
function camFallback(msg){ $('video').hidden = true; $('cam-fallback').hidden = false; $('cam-fallback-msg').textContent = msg; }

function shoot(){
  const v = $('video');
  if (!stream || !v.videoWidth){ $('file-camera').click(); return; }
  const f = el('div', 'flash'); $('scr-camera').append(f); setTimeout(() => f.remove(), 300);
  const imgs = makeImages(v, v.videoWidth, v.videoHeight);
  beginDraft(imgs, null);
}
async function onFile(e){
  const file = e.target.files && e.target.files[0]; e.target.value = '';
  if (!file) return;
  try { const {imgs, exif} = await fromFile(file); beginDraft(imgs, exif); }
  catch { toast('写真を読み込めませんでした'); }
}

/* =========================================================
   入力
   ========================================================= */
let minimap = null, draftMarker = null;
function beginDraft(imgs, exif){
  draft = {photo: imgs ? imgs.photo : null, thumb: imgs ? imgs.thumb : null, lat: null, lng: null, acc: null, src: null, moved: false, cat: null, level: 'caution'};
  if (exif){ Object.assign(draft, {lat: exif.lat, lng: exif.lng, acc: null, src: 'exif'}); }
  else if (gps){ Object.assign(draft, {lat: gps.lat, lng: gps.lng, acc: gps.acc, src: 'gps'}); }
  $('photo-wrap').hidden = !draft.photo;
  if (draft.photo) $('photo-preview').src = draft.photo;
  $('btn-retake').textContent = draft.photo ? '‹ 撮り直す' : '‹ 戻る';
  $('f-text').value = ''; $('f-place').value = ''; $('f-err').hidden = true;
  $('f-name').value = lsGet(LS.name) || '';
  renderCatGrid(); renderLevelSeg();
  show('scr-form');
  setupMinimap();
  $('post-form').scrollTop = 0;
}
function onGpsForDraft(){
  if (!draft || draft.moved || draft.src === 'exif') return;
  draft.lat = gps.lat; draft.lng = gps.lng; draft.acc = gps.acc; draft.src = 'gps';
  placeDraftMarker(true);
}
function setupMinimap(){
  if (!minimap){
    minimap = L.map('minimap', {zoomControl: false, attributionControl: true});
    L.tileLayer(GSI_URL, {maxZoom: 18, attribution: GSI_ATTR}).addTo(minimap);
    minimap.attributionControl.setPrefix(false);
    minimap.on('click', e => { if (!draft) return; Object.assign(draft, {lat: e.latlng.lat, lng: e.latlng.lng, moved: true, src: 'manual', acc: null}); placeDraftMarker(false); });
  }
  if (draft.lat != null) minimap.setView([draft.lat, draft.lng], 17);
  else minimap.setView(MAP.center, 15);
  placeDraftMarker(false);
}
function placeDraftMarker(pan){
  renderLocNote();
  if (!minimap || !draft) return;
  if (draft.lat == null){ if (draftMarker){ draftMarker.remove(); draftMarker = null; } return; }
  const ll = [draft.lat, draft.lng];
  if (!draftMarker){
    draftMarker = L.marker(ll, {draggable: true}).addTo(minimap);
    draftMarker.on('dragend', () => { const p = draftMarker.getLatLng(); Object.assign(draft, {lat: p.lat, lng: p.lng, moved: true, src: 'manual', acc: null}); renderLocNote(); });
  } else draftMarker.setLatLng(ll);
  if (pan) minimap.setView(ll, Math.max(minimap.getZoom(), 16));
}
function renderLocNote(){
  const n = $('loc-note'); n.classList.remove('warn');
  if (!draft || draft.lat == null){ n.textContent = gpsError ? gpsError + '（タップで対処法）。地図をタップして指定もできます' : '位置を取得中…（地図をタップして指定も可）'; n.classList.add('warn'); return; }
  const src = {gps: `現在地（誤差 約${draft.acc}m）`, exif: '写真の位置情報', manual: '手動で指定'}[draft.src] || '';
  const d = distM(MAP.center, [draft.lat, draft.lng]);
  n.textContent = src + (d > MAP.radiusMeters ? `・${MAP.centerName}から${(d / 1000).toFixed(1)}km` : '');
  if (d > MAP.radiusMeters) n.classList.add('warn');
}
function renderCatGrid(){
  const g = $('cat-grid'); g.textContent = '';
  CATS.forEach(c => {
    const b = el('button', 'cat-btn'); b.type = 'button'; b.setAttribute('aria-pressed', String(draft.cat === c.k));
    b.append(pinEl({cat: c.k, level: 'info'}), el('span', null, c.label));
    b.addEventListener('click', () => { draft.cat = c.k; renderCatGrid(); });
    g.append(b);
  });
}
function renderLevelSeg(){
  const s = $('level-seg'); s.textContent = '';
  LEVELS.forEach(l => {
    const b = el('button', l.k); b.type = 'button'; b.setAttribute('aria-pressed', String(draft.level === l.k));
    b.append(el('span', null, l.label), el('small', null, l.sub));
    b.addEventListener('click', () => { draft.level = l.k; renderLevelSeg(); });
    s.append(b);
  });
}
async function submit(e){
  e.preventDefault();
  const err = $('f-err'); err.hidden = true;
  const text = $('f-text').value.trim(), place = $('f-place').value.trim(), name = $('f-name').value.trim();
  if (!draft.cat){ err.textContent = '種類を選んでください'; err.hidden = false; return; }
  if (!text){ err.textContent = '状況を書いてください'; err.hidden = false; $('f-text').focus(); return; }
  if (draft.lat == null && !place){ err.textContent = '位置を取得できていません。地図をタップするか、目印を書いてください'; err.hidden = false; return; }
  if (!(await ensureMember())) return;
  lsSet(LS.name, name);
  const btn = $('btn-submit'); btn.disabled = true; btn.textContent = '送信中…';
  try {
    const now = Date.now();
    const report = {
      cat: draft.cat, level: draft.level, text, place, name,
      lat: draft.lat == null ? null : Math.round(draft.lat * 1e6) / 1e6,
      lng: draft.lng == null ? null : Math.round(draft.lng * 1e6) / 1e6,
      acc: draft.acc, locSource: draft.src, clientAt: now,
      thumb: draft.thumb, hasPhoto: !!draft.photo, status: 'open', resolvedAt: null
    };
    await store.add(report, draft.photo);
    draft = null; if (draftMarker){ draftMarker.remove(); draftMarker = null; }
    toast(navigator.onLine ? '投稿しました' : '圏外のため、つながったら自動で送信します', 4500);
    show('scr-map');
  } catch (ex) {
    err.textContent = ex && ex.message ? ex.message : '送信できませんでした。もう一度お試しください'; err.hidden = false;
  } finally { btn.disabled = false; btn.textContent = '投稿する'; }
}

/* =========================================================
   合言葉
   ========================================================= */
function ensureMember(){
  if (store.isMember()) return Promise.resolve(true);
  return new Promise(resolve => {
    const m = $('join-modal'), f = $('join-form'), err = $('join-err');
    err.hidden = true; $('join-code').value = lsGet(LS.code) || ''; m.hidden = false; $('join-code').focus();
    const done = ok => { m.hidden = true; f.removeEventListener('submit', onSub); $('join-cancel').removeEventListener('click', onCancel); resolve(ok); };
    const onCancel = () => done(false);
    const onSub = async ev => {
      ev.preventDefault();
      const code = $('join-code').value.trim();
      if (!code){ err.textContent = '合言葉を入力してください'; err.hidden = false; return; }
      $('join-submit').disabled = true;
      try { await store.join(code); lsSet(LS.code, code); done(true); }
      catch (ex) { err.textContent = ex && ex.message ? ex.message : '確認できませんでした'; err.hidden = false; }
      finally { $('join-submit').disabled = false; }
    };
    f.addEventListener('submit', onSub); $('join-cancel').addEventListener('click', onCancel);
  });
}

/* =========================================================
   地図・一覧
   ========================================================= */
let bigmap = null, pinLayer = null, meMarker = null;
function setupBigmap(){
  bigmap = L.map('bigmap', {zoomControl: false, maxBounds: areaBounds(MAP.panLimit), maxBoundsViscosity: 0.7, minZoom: 12, maxZoom: 18});
  L.tileLayer(GSI_URL, {maxZoom: 18, attribution: GSI_ATTR}).addTo(bigmap);
  bigmap.attributionControl.setPrefix(false);
  L.circle(MAP.center, {radius: MAP.radiusMeters, color: '#1f47c4', weight: 2, dashArray: '6 6', fill: false, interactive: false}).addTo(bigmap);
  L.circleMarker(MAP.center, {radius: 6, color: '#1f47c4', weight: 2, fillColor: '#ffffff', fillOpacity: 1}).bindTooltip(MAP.centerName).addTo(bigmap);
  bigmap.fitBounds(areaBounds(1));
  pinLayer = L.layerGroup().addTo(bigmap);
  $('map-title').textContent = MAP.title;
  document.title = MAP.title;
}
function updateMeMarker(){
  if (!bigmap || !gps) return;
  if (!meMarker) meMarker = L.marker([gps.lat, gps.lng], {icon: L.divIcon({className: 'pin-icon', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9]}), interactive: false, keyboard: false, zIndexOffset: -100}).addTo(bigmap);
  else meMarker.setLatLng([gps.lat, gps.lng]);
}
const visible = () => reports.filter(r => (showDone || r.status !== 'resolved') && (!filterCats.size || filterCats.has(catOf(r.cat).k)));
function render(){
  const open = reports.filter(r => r.status !== 'resolved');
  $('c-urgent').textContent = open.filter(r => r.level === 'urgent').length;
  $('c-open').textContent = open.length; $('c-all').textContent = reports.length;
  $('sheet-label').textContent = `投稿一覧（${visible().length}件）`;
  renderFilters(); renderList(); renderPins();
}
function renderFilters(){
  const f = $('filters'); f.textContent = '';
  const base = reports.filter(r => showDone || r.status !== 'resolved');
  const all = el('button', 'fchip'); all.type = 'button'; all.setAttribute('aria-pressed', String(!filterCats.size));
  all.append(document.createTextNode('すべて'), el('i', null, String(base.length)));
  all.addEventListener('click', () => { filterCats.clear(); render(); }); f.append(all);
  CATS.forEach(c => {
    const n = base.filter(r => catOf(r.cat).k === c.k).length;
    if (!n && !filterCats.has(c.k)) return;
    const b = el('button', 'fchip c-' + c.k); b.type = 'button'; b.setAttribute('aria-pressed', String(filterCats.has(c.k)));
    b.append(el('span', 'dot'), document.createTextNode(c.label), el('i', null, String(n)));
    b.addEventListener('click', () => { filterCats.has(c.k) ? filterCats.delete(c.k) : filterCats.add(c.k); render(); });
    f.append(b);
  });
}
function renderList(){
  const ul = $('list'); ul.textContent = '';
  visible().forEach(r => {
    const li = el('li'); const b = el('button', 'item' + (r.status === 'resolved' ? ' done' : '')); b.type = 'button';
    const body = el('div');
    const meta = el('div', 'meta');
    const lvk = r.pending ? 'pend' : r.status === 'resolved' ? 'done' : lvOf(r.level).k;
    meta.append(el('span', 'lv ' + lvk, r.pending ? '未送信' : r.status === 'resolved' ? '解消済み' : lvOf(r.level).label), el('b', null, catOf(r.cat).label));
    const t = el('time', null, fmtTime(r.time)); meta.append(t);
    body.append(meta, el('div', 'txt', r.text || ''));
    const sub = [r.place, r.name, relTime(r.time)].filter(Boolean).join('・');
    body.append(el('div', 'sub', sub));
    b.append(pinEl(r), body);
    if (r.thumb){ const im = el('img'); im.src = r.thumb; im.alt = ''; b.append(im); } else b.append(el('span'));
    b.addEventListener('click', () => openDetail(r.id, true));
    li.append(b); ul.append(li);
  });
  const em = $('empty');
  em.hidden = !!visible().length;
  em.textContent = reports.length ? '条件に合う投稿はありません。' : 'まだ投稿はありません。「撮影して投稿」から最初の情報を登録できます。';
}
/* 投稿一覧のシート：上下にスライドして「見出しだけ／3割／8割」を切り替える */
const SHEET_ORDER = ['min', 'mid', 'max'];
// 上部の見出し（地図名・件数）の高さ。一覧はこの下端までしか上げない
function barH(){ const b = document.querySelector('#scr-map .map-bar'); const h = b ? b.getBoundingClientRect().height : 0; $('scr-map').style.setProperty('--bar-h', h + 'px'); return h; }
function setSheet(state){
  barH();
  $('scr-map').dataset.sheet = state;
  const sh = $('sheet-list'); sh.style.height = '';
  $('btn-sheet').setAttribute('aria-expanded', String(state !== 'min'));
}
function setupSheetDrag(){
  const sh = $('sheet-list'), grab = $('btn-sheet');
  let startY = 0, startH = 0, moved = false, active = false;
  const heights = () => {
    const vh = $('scr-map').clientHeight - barH(); const min = $('btn-sheet').offsetHeight + parseFloat(getComputedStyle(sh).paddingBottom || 0);
    return {min, mid: vh * 0.34, max: vh};
  };
  const down = e => {
    if (window.matchMedia('(min-width: 760px)').matches) return;
    active = true; moved = false; startY = e.clientY; startH = sh.getBoundingClientRect().height;
    sh.classList.add('dragging'); grab.setPointerCapture && grab.setPointerCapture(e.pointerId);
  };
  const move = e => {
    if (!active) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 6) moved = true;
    if (!moved) return;
    const h = heights();
    sh.style.height = Math.max(h.min * 0.8, Math.min(h.max, startH + dy)) + 'px';
    e.preventDefault();
  };
  const up = e => {
    if (!active) return; active = false; sh.classList.remove('dragging');
    const cur = $('scr-map').dataset.sheet;
    if (!moved){ // タップ：見出しだけ→3割→8割→見出しだけ
      setSheet(cur === 'min' ? 'mid' : cur === 'mid' ? 'max' : 'min'); return;
    }
    const hNow = sh.getBoundingClientRect().height, h = heights(), dy = startY - e.clientY;
    // 勢いよく払ったときは、その方向の次の段階へ
    let target;
    if (Math.abs(dy) > 60){
      const i = SHEET_ORDER.indexOf(cur);
      target = dy > 0 ? SHEET_ORDER[Math.min(2, i + 1)] : SHEET_ORDER[Math.max(0, i - 1)];
      if (dy < -h.max * 0.35) target = 'min';
      if (dy > h.max * 0.35) target = 'max';
    } else {
      target = SHEET_ORDER.reduce((a, k) => Math.abs(h[k] - hNow) < Math.abs(h[a] - hNow) ? k : a, 'min');
    }
    setSheet(target);
  };
  grab.addEventListener('pointerdown', down);
  grab.addEventListener('pointermove', move);
  grab.addEventListener('pointerup', up);
  grab.addEventListener('pointercancel', up);
  grab.addEventListener('click', e => e.preventDefault());
  grab.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault();
    const cur = $('scr-map').dataset.sheet; setSheet(cur === 'min' ? 'mid' : cur === 'mid' ? 'max' : 'min');
  });
}

function renderPins(){
  if (!pinLayer) return;
  pinLayer.clearLayers();
  visible().slice().reverse().forEach(r => {
    if (r.lat == null) return;
    const w = el('div'); w.append(pinEl(r, r.id === selected ? ' sel' : ''));
    L.marker([r.lat, r.lng], {icon: L.divIcon({className: 'pin-icon', html: w.innerHTML, iconSize: [30, 30], iconAnchor: [15, 15]}), zIndexOffset: r.level === 'urgent' ? 1000 : 0, riseOnHover: true})
      .on('click', () => openDetail(r.id, false)).addTo(pinLayer);
  });
}
async function openDetail(id, fly){
  const r = reports.find(x => x.id === id); if (!r) return;
  selected = id;
  detailReturnSheet = $('scr-map').dataset.sheet; // 一覧に戻ったとき元の大きさに戻す
  if (fly && r.lat != null){ bigmap.flyTo([r.lat, r.lng], Math.max(bigmap.getZoom(), 16), {duration: .5}); setSheet('min'); }
  const d = $('detail'); d.textContent = '';
  const head = el('div', 'head'); const h = el('h2', null, catOf(r.cat).label); h.id = 'd-title';
  const back = el('button', 'back-btn', '‹ 一覧に戻る'); back.type = 'button'; back.addEventListener('click', closeDetail);
  head.append(back, h, el('span', 'head-spacer')); d.append(head);
  const meta = el('div', 'meta'); meta.append(pinEl(r), el('span', 'lv ' + (r.status === 'resolved' ? 'done' : lvOf(r.level).k), r.status === 'resolved' ? '解消済み' : lvOf(r.level).label));
  if (r.pending) meta.append(el('span', 'lv pend', '未送信（つながったら送信）'));
  d.append(meta);
  if (r.hasPhoto){
    const img = el('img', 'photo'); img.alt = '投稿された写真'; img.src = r.thumb || ''; d.append(img);
    store.photo(r.id).then(src => { if (src) img.src = src; }).catch(() => {});
  }
  d.append(el('p', 'd-text', r.text || ''));
  const dl = el('dl', 'dl'); const add = (k, v) => dl.append(el('dt', null, k), el('dd', null, v));
  if (r.place) add('目印', r.place);
  if (r.lat != null){
    const dd = el('dd'); dd.append(el('span', 'num', `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}　`));
    const a = el('a', null, '地理院地図で開く'); a.href = `https://maps.gsi.go.jp/#17/${r.lat.toFixed(6)}/${r.lng.toFixed(6)}/`; a.target = '_blank'; a.rel = 'noopener';
    dd.append(a); dl.append(el('dt', null, '位置'), dd);
    const srcLabel = {gps: r.acc != null ? `スマホの現在地（誤差 約${r.acc}m）` : 'スマホの現在地', exif: '写真の位置情報', manual: '地図で指定'}[r.locSource];
    if (srcLabel) add('位置の取得', srcLabel);
  } else add('位置', 'なし');
  add('投稿', [r.name || '名前なし', fmtTime(r.time)].join('・'));
  if (r.status === 'resolved' && r.resolvedAt) add('解消', fmtTime(r.resolvedAt));
  d.append(dl);
  const acts = el('div', 'd-actions');
  const tg = el('button', 'ghost', r.status === 'resolved' ? '対応中に戻す' : '解消済みにする'); tg.type = 'button';
  tg.addEventListener('click', async () => {
    if (!(await ensureMember())) return;
    tg.disabled = true;
    try { await store.setStatus(r.id, r.status === 'resolved' ? 'open' : 'resolved'); closeDetail(); toast('更新しました'); }
    catch (ex) { toast(ex && ex.message ? ex.message : '更新できませんでした'); tg.disabled = false; }
  });
  acts.append(tg); d.append(acts);
  const back2 = el('button', 'ghost back-wide', '一覧に戻る'); back2.type = 'button'; back2.addEventListener('click', closeDetail); d.append(back2);
  $('detail-modal').hidden = false; d.scrollTop = 0;
  renderPins();
}
let detailReturnSheet = null;
function closeDetail(){
  $('detail-modal').hidden = true; selected = null; renderPins();
  if (detailReturnSheet){ setSheet(detailReturnSheet); detailReturnSheet = null; }
}

/* =========================================================
   保存先：端末内（お試しモード）
   ========================================================= */
function localStore(){
  const load = () => { try { return JSON.parse(lsGet(LS.local) || '[]'); } catch { return []; } };
  const save = a => { try { localStorage.setItem(LS.local, JSON.stringify(a)); } catch { throw new Error('端末の保存容量が足りません。古い投稿を減らしてください'); } };
  let cb = () => {};
  const emit = () => cb(load().map(r => Object.assign({}, r, {time: r.clientAt})).sort((a, b) => b.time - a.time));
  return {
    mode: 'local',
    async init(){},
    isMember: () => true,
    async join(){},
    onReports(fn){ cb = fn; emit(); },
    async add(r, photo){ const a = load(); a.push(Object.assign({id: 'l' + Date.now().toString(36), photo}, r)); save(a); emit(); },
    async setStatus(id, status){ const a = load(); const r = a.find(x => x.id === id); if (r){ r.status = status; r.resolvedAt = status === 'resolved' ? Date.now() : null; save(a); emit(); } },
    async photo(id){ const r = load().find(x => x.id === id); return r && r.photo; },
  };
}

/* =========================================================
   保存先：Firebase（全員で共有）
   ========================================================= */
async function firebaseStore(){
  const V = '10.12.2';
  const [{initializeApp}, A, F] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const app = initializeApp(FIREBASE_CONFIG);
  const auth = A.getAuth(app);
  let db;
  try { db = F.initializeFirestore(app, {localCache: F.persistentLocalCache({tabManager: F.persistentMultipleTabManager()})}); }
  catch { db = F.getFirestore(app); }
  await A.signInAnonymously(auth).catch(() => {});
  await new Promise(res => { const u = A.onAuthStateChanged(auth, x => { if (x){ u(); res(); } }); setTimeout(res, 8000); });
  let member = false;
  const uid = () => auth.currentUser && auth.currentUser.uid;
  if (uid()){
    // 圏外で起動したときのため、一度確認できた端末は覚えておく
    member = lsGet('saigai.member') === uid();
    try { member = (await F.getDoc(F.doc(db, 'members', uid()))).exists(); if (member) lsSet('saigai.member', uid()); } catch {}
  }
  const denied = ex => ex && (ex.code === 'permission-denied');
  return {
    mode: 'firebase',
    isMember: () => member,
    async join(code){
      if (!uid()) throw new Error('ネットワークにつながっていません。電波のある場所でお試しください');
      if (!navigator.onLine) throw new Error('合言葉の確認には通信が必要です。電波のある場所でお試しください');
      try { await F.setDoc(F.doc(db, 'members', uid()), {code, joinedAt: F.serverTimestamp()}); member = true; lsSet('saigai.member', uid()); }
      catch (ex) { if (denied(ex)) throw new Error('合言葉が違います'); throw new Error('確認できませんでした。通信状況を確認してください'); }
    },
    onReports(fn){
      const q = F.query(F.collection(db, 'reports'), F.orderBy('clientAt', 'desc'), F.limit(500));
      F.onSnapshot(q, {includeMetadataChanges: true}, snap => {
        fn(snap.docs.map(d => { const x = d.data(); return Object.assign({id: d.id, pending: d.metadata.hasPendingWrites}, x, {time: x.clientAt, resolvedAt: x.resolvedAt && x.resolvedAt.toMillis ? x.resolvedAt.toMillis() : x.resolvedAt}); }));
      }, () => toast('投稿を読み込めませんでした。通信状況を確認してください'));
    },
    async add(r, photo){
      if (!uid()) throw new Error('ネットワークにつながっていません。電波のある場所でお試しください');
      const ref = F.doc(F.collection(db, 'reports'));
      const b = F.writeBatch(db);
      b.set(ref, Object.assign({}, r, {author: uid(), createdAt: F.serverTimestamp()}));
      if (photo) b.set(F.doc(db, 'photos', ref.id), {data: photo, author: uid()});
      // 圏外でも端末に保存され、つながった時点で送信される。完了は待たない
      b.commit().catch(ex => toast(denied(ex) ? '投稿が拒否されました。合言葉を確認してください' : '送信できなかった投稿があります', 5000));
    },
    async setStatus(id, status){
      F.updateDoc(F.doc(db, 'reports', id), {status, resolvedAt: status === 'resolved' ? F.serverTimestamp() : null})
        .catch(ex => toast(denied(ex) ? '更新が拒否されました' : '更新できませんでした'));
    },
    async photo(id){ const s = await F.getDoc(F.doc(db, 'photos', id)); return s.exists() ? s.data().data : null; },
  };
}

/* =========================================================
   起動
   ========================================================= */
async function boot(){
  $('btn-shutter').addEventListener('click', shoot);
  $('gps-chip').addEventListener('click', () => { if (gpsError) openGpsHelp(); else if (!gps) retryGps(); });
  $('loc-note').addEventListener('click', () => { if (gpsError) openGpsHelp(); });
  $('gps-retry').addEventListener('click', () => { $('gps-help').hidden = true; retryGps(); });
  $('gps-close').addEventListener('click', () => { $('gps-help').hidden = true; });
  $('file-camera').addEventListener('change', onFile);
  $('file-library').addEventListener('change', onFile);
  $('btn-nophoto').addEventListener('click', () => beginDraft(null, null));
  $('btn-to-map').addEventListener('click', () => show('scr-map'));
  $('btn-to-camera').addEventListener('click', () => show('scr-camera'));
  $('btn-retake').addEventListener('click', () => { draft = null; if (draftMarker){ draftMarker.remove(); draftMarker = null; } show('scr-camera'); });
  $('btn-loc-reset').addEventListener('click', () => {
    if (!gps){ toast(gpsError || '現在地をまだ取得できていません'); return; }
    Object.assign(draft, {lat: gps.lat, lng: gps.lng, acc: gps.acc, src: 'gps', moved: false}); placeDraftMarker(true);
  });
  $('post-form').addEventListener('submit', submit);
  setupSheetDrag();
  setSheet('min');
  window.addEventListener('resize', barH);
  $('show-done').addEventListener('change', e => { showDone = e.target.checked; render(); });
  $('btn-locate').addEventListener('click', () => { if (gps) bigmap.flyTo([gps.lat, gps.lng], 17, {duration: .5}); else toast(gpsError || '現在地をまだ取得できていません'); });
  $('detail-modal').addEventListener('click', e => { if (e.target === $('detail-modal')) closeDetail(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); else if (!$('scr-camera').hidden) startCamera(); });

  setupBigmap();
  startGps();
  show('scr-camera');

  const useFirebase = !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey);
  try { store = useFirebase ? await firebaseStore() : localStore(); }
  catch { store = localStore(); toast('共有サーバーに接続できないため、この端末の中だけに保存します', 5000); }
  if (store.mode === 'local') $('mode-chip').hidden = false;
  store.onReports(list => { reports = list; render(); });

  if ('serviceWorker' in navigator){
    // 新しい版が届いたら、入力中でなければ1回だけ読み込み直して最新にする
    const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      const reload = () => { if (reloaded) return; reloaded = true; location.reload(); };
      if (!draft) reload(); else toast('アプリが更新されました。投稿後に自動で最新になります', 5000);
      const t = setInterval(() => { if (!draft){ clearInterval(t); reload(); } }, 2000);
    });
    navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
  }
}
boot();
