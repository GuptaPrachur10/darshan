'use strict';

/*
 * Dress Catalog: a static, single-page app.
 *
 * Text comes from config.json (in the repo). Photos come from Google Drive,
 * fetched only when a dress (or night outfit) is opened:
 *   settings.dressesFolderId/<dress id>/*.jpg
 *   settings.nightOutfitsFolderId/<letter>/*.jpg
 *
 * Pages (hash routes, so GitHub Pages needs no server config):
 *   #/            text-only list with search + filters
 *   #/dress/7     dress card + photo gallery
 *   #/night/E     night outfit photos + dresses that use it
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const ALL_MARKS = new Set(['✓', '✔', 'Y', 'y', 'yes', 'Yes', 'YES']);
const ORIGINAL_MIME_OK = /^image\/(jpeg|png|webp|gif)$/; // browsers can't show HEIC originals
const WEATHER = {
  hot: { short: 'Hot', long: 'Hot Weather', icon: '☀' },
  cold: { short: 'Cold', long: 'Cold Weather', icon: '❄' },
  both: { short: 'Hot & Cold', long: 'Hot & Cold Weather', icon: '☀❄' },
};

const state = {
  config: null,
  settings: null,
  filters: { q: '', weather: '', color: '' },
  photoCache: new Map(), // "<parentId>/<name>" -> photos[] | null (folder missing)
  galleryToken: 0,
  view: '',
  homeScroll: 0,
};

const app = document.getElementById('app');

// ---------------------------------------------------------------- helpers

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isAll(mark) {
  return mark === true || ALL_MARKS.has(mark);
}

function markText(mark) {
  return isAll(mark) ? '✓' : String(mark);
}

/** "light blue" -> "Light Blue", whatever case it was typed in. */
function colorName(c) {
  return String(c).trim().toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function colorList(colors) {
  return (colors || []).map(colorName).join(', ');
}

function weatherInfo(w) {
  return WEATHER[w] || { short: w || '?', long: w || 'Unknown' };
}

function sortedDresses() {
  return [...state.config.dresses].sort((a, b) => a.id - b.id);
}

function findDress(id) {
  return state.config.dresses.find((d) => d.id === id);
}

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- Drive

function driveReady(folderId) {
  const s = state.settings;
  return Boolean(s && s.apiKey && !s.apiKey.startsWith('YOUR_') &&
    folderId && !folderId.startsWith('YOUR_'));
}

function quote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveList(q, fields) {
  const params = new URLSearchParams({
    q,
    fields,
    key: state.settings.apiKey,
    pageSize: '1000',
    orderBy: 'name_natural',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const res = await fetch(`${DRIVE_API}?${params}`);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error.message || msg; } catch (_) { /* keep msg */ }
    throw new Error(msg);
  }
  return (await res.json()).files || [];
}

/** Returns the photos in <parentId>/<name>, or null if that folder doesn't exist. */
async function photosIn(parentId, name) {
  const key = `${parentId}/${name}`;
  if (state.photoCache.has(key)) return state.photoCache.get(key);

  const folders = await driveList(
    `'${quote(parentId)}' in parents and name = '${quote(name)}' and ` +
    `mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    'files(id,name)');

  let photos = null;
  if (folders.length) {
    const files = await driveList(
      `'${quote(folders[0].id)}' in parents and mimeType contains 'image/' and trashed = false`,
      'files(id,name,mimeType,thumbnailLink,imageMediaMetadata(width,height))');
    photos = files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      thumb: f.thumbnailLink || '',
      width: f.imageMediaMetadata?.width || 0,
      height: f.imageMediaMetadata?.height || 0,
    }));
  }
  state.photoCache.set(key, photos);
  return photos;
}

/** A Drive-rendered preview at roughly `size` px on the long edge. */
function previewUrl(photo, size) {
  if (photo.thumb) return photo.thumb.replace(/=s\d+[^/]*$/, '') + `=s${size}`;
  return `https://lh3.googleusercontent.com/d/${encodeURIComponent(photo.id)}=s${size}`;
}

function originalUrl(photo) {
  return `${DRIVE_API}/${encodeURIComponent(photo.id)}?alt=media&key=${encodeURIComponent(state.settings.apiKey)}`;
}

// ---------------------------------------------------------------- routing

function route() {
  closeViewer();
  if (state.view === 'home') state.homeScroll = window.scrollY;

  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
    .map(decodeURIComponent);

  if (parts[0] === 'dress' && parts[1]) {
    state.view = 'dress';
    renderDress(Number(parts[1]));
    window.scrollTo(0, 0);
  } else if (parts[0] === 'night' && parts[1]) {
    state.view = 'night';
    renderNight(parts[1].toUpperCase());
    window.scrollTo(0, 0);
  } else {
    state.view = 'home';
    renderHome();
    window.scrollTo(0, state.homeScroll);
  }
}

// ---------------------------------------------------------------- home

function allColors() {
  const set = new Set();
  state.config.dresses.forEach((d) => (d.colors || []).forEach((c) => set.add(String(c).toLowerCase())));
  return [...set].sort();
}

function chipGroup(label, key, options) {
  if (!options.length) return '';
  const chips = options.map((o) => `
    <button type="button" class="chip${state.filters[key] === o.value ? ' on' : ''}"
            data-key="${key}" data-value="${esc(o.value)}">${esc(o.label)}</button>`).join('');
  return `<div class="chip-group"><span class="chip-label">${esc(label)}</span>${chips}</div>`;
}

function renderHome() {
  const f = state.filters;
  app.innerHTML = `
    <section class="controls panel">
      <input id="search" type="search" placeholder="Search by number or name"
             value="${esc(f.q)}" autocomplete="off">
      ${chipGroup('Weather', 'weather', [
        { value: 'hot', label: 'Hot' }, { value: 'cold', label: 'Cold' }])}
      ${chipGroup('Color', 'color', allColors().map((c) => ({ value: c, label: colorName(c) })))}
    </section>
    <p id="count" class="count"></p>
    <ul id="list" class="list"></ul>`;

  document.getElementById('search').addEventListener('input', (e) => {
    f.q = e.target.value;
    updateList();
  });
  app.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
    const { key, value } = chip.dataset;
    f[key] = f[key] === value ? '' : value; // tap again to clear
    app.querySelectorAll(`.chip[data-key="${key}"]`).forEach((c) =>
      c.classList.toggle('on', c.dataset.value === f[key]));
    updateList();
  }));
  updateList();
}

function matches(d) {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  if (q && !String(d.id).startsWith(q) && !String(d.name || '').toLowerCase().includes(q)) return false;
  if (f.weather && d.weather !== f.weather && d.weather !== 'both') return false;
  if (f.color && !(d.colors || []).some((c) => String(c).toLowerCase() === f.color)) return false;
  return true;
}

function updateList() {
  const shown = sortedDresses().filter(matches);
  document.getElementById('count').textContent =
    `${shown.length} of ${state.config.dresses.length} dresses`;
  document.getElementById('list').innerHTML = shown.map((d) => {
    const w = weatherInfo(d.weather);
    const meta = [
      colorList(d.colors),
      d.nightOutfits?.length ? `Night: ${d.nightOutfits.join(' ')}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <li><a class="row" href="#/dress/${d.id}">
        <span class="num">${esc(d.id)}</span>
        <span class="row-main">
          <span class="row-name">${esc(d.name)}</span>
          ${meta ? `<span class="row-meta">${esc(meta)}</span>` : ''}
        </span>
        <span class="badge weather-${esc(d.weather)}">${esc(w.short)}</span>
      </a></li>`;
  }).join('') || '<li class="status">No dresses match these filters.</li>';
}

// ---------------------------------------------------------------- dress

function jewelryTable(d) {
  const jw = d.jewelry || {};
  if (!Object.keys(jw).length) return '';
  const g = state.config.glossary || {};
  // Glossary order first; unknown codes are still shown (raw) instead of dropped.
  const rows = [...new Set([...(g.deitySets || []), ...Object.keys(jw)])];
  const cols = [...new Set([...(g.jewelry || []), ...Object.values(jw).flatMap((r) => Object.keys(r || {}))])];

  const head = cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('');
  const body = rows.map((r) => `
    <tr><th scope="row">${esc(r)}</th>${cols.map((c) => {
      const mark = jw[r]?.[c];
      return `<td>${mark === undefined || mark === '' ? '' : esc(markText(mark))}</td>`;
    }).join('')}</tr>`).join('');
  return `<table class="jewelry"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function nightLinks(letters) {
  const linked = driveReady(state.settings?.nightOutfitsFolderId);
  return letters.map((l) => (linked
    ? `<a class="pill" href="#/night/${encodeURIComponent(l)}">${esc(l)}</a>`
    : `<span class="pill">${esc(l)}</span>`)).join(' ');
}

function renderDress(id) {
  const d = findDress(id);
  if (!d) {
    app.innerHTML = `<p class="status">Dress ${esc(id)} not found. <a href="#/">Back to all dresses</a></p>`;
    return;
  }
  const list = sortedDresses();
  const i = list.indexOf(d);
  const prev = list[i - 1];
  const next = list[i + 1];
  const w = weatherInfo(d.weather);

  app.innerHTML = `
    <nav class="crumbs">
      <a href="#/">← All dresses</a>
      <span class="pager">
        ${prev ? `<a href="#/dress/${prev.id}" aria-label="Previous dress">‹ ${esc(prev.id)}</a>` : ''}
        ${next ? `<a href="#/dress/${next.id}" aria-label="Next dress">${esc(next.id)} ›</a>` : ''}
      </span>
    </nav>
    <article class="card">
      <header class="card-head">
        <span class="num-badge">${esc(d.id)}</span>
        <h1>${esc(d.name)}</h1>
        <span class="sticker sticker-${esc(d.weather)}">
          <span class="sticker-icon" aria-hidden="true">${esc(w.icon)}</span>
          <span>Suitable for <b>${esc(w.long)}</b></span>
        </span>
      </header>
      ${jewelryTable(d)}
      <dl class="facts">
        ${d.nightOutfits?.length ? `<dt>Night outfit options</dt><dd>${nightLinks(d.nightOutfits)}</dd>` : ''}
        ${d.colors?.length ? `<dt>Colors</dt><dd>${esc(colorList(d.colors))}</dd>` : ''}
        ${d.backdrop ? `<dt>Matching backdrop</dt><dd>${esc(d.backdrop)}</dd>` : ''}
      </dl>
    </article>
    <section class="photos">
      <h2>Photos</h2>
      <div id="gallery" class="gallery"></div>
    </section>`;

  loadGallery(state.settings?.dressesFolderId, String(d.id));
}

// ---------------------------------------------------------------- night outfit

function renderNight(letter) {
  const users = sortedDresses().filter((d) => (d.nightOutfits || []).includes(letter));
  app.innerHTML = `
    <nav class="crumbs"><a href="#/">← All dresses</a></nav>
    <article class="card">
      <header class="card-head">
        <span class="num-badge">${esc(letter)}</span>
        <h1>Night outfit ${esc(letter)}</h1>
      </header>
      ${users.length ? `<p class="facts-line">Listed with: ${users.map((d) =>
        `<a class="pill" href="#/dress/${d.id}">${esc(d.id)} · ${esc(d.name)}</a>`).join(' ')}</p>` : ''}
    </article>
    <section class="photos">
      <h2>Photos</h2>
      <div id="gallery" class="gallery"></div>
    </section>`;

  loadGallery(state.settings?.nightOutfitsFolderId, letter);
}

// ---------------------------------------------------------------- gallery

async function loadGallery(parentId, name) {
  const el = document.getElementById('gallery');
  const token = ++state.galleryToken;
  if (!driveReady(parentId)) {
    el.innerHTML = '<p class="status">Photos are not set up yet (see settings.json).</p>';
    return;
  }
  el.innerHTML = '<p class="status">Loading photos…</p>';
  try {
    const photos = await photosIn(parentId, name);
    if (token !== state.galleryToken) return; // user navigated away
    if (!photos || !photos.length) {
      el.innerHTML = '<p class="status">No photos yet.</p>';
      return;
    }
    el.innerHTML = photos.map((p, i) => `
      <button type="button" class="thumb" data-i="${i}" aria-label="Open ${esc(p.name)}">
        <img loading="lazy" src="${esc(previewUrl(p, 800))}" alt="${esc(p.name)}">
      </button>`).join('');
    el.querySelectorAll('.thumb').forEach((b) =>
      b.addEventListener('click', () => openViewer(photos, Number(b.dataset.i))));
  } catch (err) {
    if (token === state.galleryToken) {
      el.innerHTML = `<p class="status error">Could not load photos: ${esc(err.message)}</p>`;
    }
  }
}

// ---------------------------------------------------------------- viewer (zoom)

const viewer = {
  el: document.getElementById('viewer'),
  stage: document.getElementById('viewer-stage'),
  img: document.getElementById('viewer-img'),
  info: document.getElementById('viewer-info'),
  photos: [],
  index: 0,
  s: 1, tx: 0, ty: 0,           // current scale and translation
  fitW: 0, fitH: 0, maxS: 4,
  original: 'none',             // none | loading | done | failed
  pointers: new Map(),
  pinch: null,
  gesture: null,
  lastTap: 0,
};

function openViewer(photos, index) {
  viewer.photos = photos;
  viewer.el.hidden = false;
  document.body.classList.add('no-scroll');
  showPhoto(index);
}

function closeViewer() {
  if (viewer.el.hidden) return;
  viewer.el.hidden = true;
  document.body.classList.remove('no-scroll');
  viewer.img.removeAttribute('src');
}

function updateInfo() {
  const n = viewer.photos.length;
  const extra = viewer.original === 'loading' ? ' · loading full resolution…'
    : viewer.original === 'done' ? ' · full resolution' : '';
  viewer.info.textContent = `${viewer.index + 1} / ${n}${extra}`;
}

function showPhoto(index) {
  const n = viewer.photos.length;
  viewer.index = ((index % n) + n) % n;
  viewer.original = 'none';
  updateInfo();
  const img = viewer.img;
  img.style.visibility = 'hidden';
  img.onload = () => {
    img.onload = null;
    fitImage();
    img.style.visibility = '';
  };
  img.src = previewUrl(viewer.photos[viewer.index], 2000);
}

function fitImage() {
  const W = viewer.stage.clientWidth;
  const H = viewer.stage.clientHeight;
  const nw = viewer.img.naturalWidth || 1;
  const nh = viewer.img.naturalHeight || 1;
  const r = Math.min(W / nw, H / nh);
  viewer.fitW = nw * r;
  viewer.fitH = nh * r;
  viewer.img.style.width = `${viewer.fitW}px`;
  viewer.img.style.height = `${viewer.fitH}px`;

  const p = viewer.photos[viewer.index];
  const origLong = Math.max(p.width, p.height);
  viewer.maxS = Math.max(4, origLong ? (origLong / Math.max(viewer.fitW, viewer.fitH)) * 2 : 4);
  resetZoom();
}

function resetZoom() {
  viewer.s = 1;
  clampPan();
  applyTransform();
}

function clampPan() {
  const W = viewer.stage.clientWidth;
  const H = viewer.stage.clientHeight;
  const w = viewer.fitW * viewer.s;
  const h = viewer.fitH * viewer.s;
  viewer.tx = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, viewer.tx));
  viewer.ty = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, viewer.ty));
}

function applyTransform() {
  viewer.img.style.transform = `translate(${viewer.tx}px, ${viewer.ty}px) scale(${viewer.s})`;
}

function zoomAt(px, py, newScale) {
  const ns = Math.min(viewer.maxS, Math.max(1, newScale));
  viewer.tx = px - (px - viewer.tx) * (ns / viewer.s);
  viewer.ty = py - (py - viewer.ty) * (ns / viewer.s);
  viewer.s = ns;
  clampPan();
  applyTransform();
  maybeLoadOriginal();
}

/** Swap in the full-resolution file only once the user actually zooms in. */
function maybeLoadOriginal() {
  if (viewer.s < 1.5 || viewer.original !== 'none') return;
  const photo = viewer.photos[viewer.index];
  if (!ORIGINAL_MIME_OK.test(photo.mimeType)) {
    viewer.original = 'failed'; // e.g. HEIC: stay on the Drive preview
    return;
  }
  viewer.original = 'loading';
  updateInfo();
  const index = viewer.index;
  const full = new Image();
  full.onload = () => {
    if (viewer.index !== index || viewer.el.hidden) return;
    viewer.img.src = full.src; // same box size, so the zoom position is kept
    viewer.original = 'done';
    updateInfo();
  };
  full.onerror = () => {
    if (viewer.index !== index) return;
    viewer.original = 'failed';
    updateInfo();
  };
  full.src = originalUrl(photo);
}

function stagePoint(e) {
  const r = viewer.stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function pinchInfo() {
  const [a, b] = [...viewer.pointers.values()];
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

viewer.stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = stagePoint(e);
  zoomAt(p.x, p.y, viewer.s * Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

viewer.stage.addEventListener('pointerdown', (e) => {
  viewer.stage.setPointerCapture(e.pointerId);
  const p = stagePoint(e);
  viewer.pointers.set(e.pointerId, p);
  if (viewer.pointers.size === 2) {
    const { dist, mid } = pinchInfo();
    viewer.pinch = { dist, s: viewer.s, mid };
    viewer.gesture = null;
  } else if (viewer.pointers.size === 1) {
    viewer.gesture = { start: p, last: p, moved: false };
  }
});

viewer.stage.addEventListener('pointermove', (e) => {
  if (!viewer.pointers.has(e.pointerId)) return;
  const p = stagePoint(e);
  viewer.pointers.set(e.pointerId, p);

  if (viewer.pinch && viewer.pointers.size === 2) {
    const { dist, mid } = pinchInfo();
    viewer.tx += mid.x - viewer.pinch.mid.x; // two-finger pan
    viewer.ty += mid.y - viewer.pinch.mid.y;
    viewer.pinch.mid = mid;
    zoomAt(mid.x, mid.y, viewer.pinch.s * (dist / viewer.pinch.dist));
  } else if (viewer.gesture) {
    const g = viewer.gesture;
    if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 8) g.moved = true;
    if (viewer.s > 1) {
      viewer.tx += p.x - g.last.x;
      viewer.ty += p.y - g.last.y;
      clampPan();
      applyTransform();
    }
    g.last = p;
  }
});

function endPointer(e) {
  if (!viewer.pointers.has(e.pointerId)) return;
  viewer.pointers.delete(e.pointerId);
  if (viewer.pointers.size < 2) viewer.pinch = null;

  const g = viewer.gesture;
  if (!g || viewer.pointers.size) return;
  viewer.gesture = null;
  if (e.type === 'pointercancel') return;

  const p = stagePoint(e);
  const dx = p.x - g.start.x;
  const dy = p.y - g.start.y;
  if (!g.moved) {
    // Double tap / double click toggles zoom.
    const now = Date.now();
    if (now - viewer.lastTap < 300) {
      viewer.lastTap = 0;
      if (viewer.s > 1) resetZoom(); else zoomAt(p.x, p.y, 3);
    } else {
      viewer.lastTap = now;
    }
  } else if (viewer.s === 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
    showPhoto(viewer.index + (dx < 0 ? 1 : -1)); // swipe when not zoomed
  }
}
viewer.stage.addEventListener('pointerup', endPointer);
viewer.stage.addEventListener('pointercancel', endPointer);

document.getElementById('viewer-prev').addEventListener('click', () => showPhoto(viewer.index - 1));
document.getElementById('viewer-next').addEventListener('click', () => showPhoto(viewer.index + 1));
document.getElementById('viewer-close').addEventListener('click', closeViewer);

document.addEventListener('keydown', (e) => {
  if (viewer.el.hidden) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') showPhoto(viewer.index - 1);
  else if (e.key === 'ArrowRight') showPhoto(viewer.index + 1);
});

window.addEventListener('resize', () => {
  if (!viewer.el.hidden && viewer.img.naturalWidth) fitImage();
});

// ---------------------------------------------------------------- start

async function start() {
  try {
    state.config = await loadJson('config.json');
  } catch (err) {
    app.innerHTML = `<p class="status error">Could not load config.json: ${esc(err.message)}</p>`;
    return;
  }
  try {
    state.settings = await loadJson('settings.json');
  } catch (_) {
    state.settings = null; // text still works; galleries say "not set up"
  }
  state.config.dresses = state.config.dresses || [];
  window.addEventListener('hashchange', route);
  route();
}

start();
