'use strict';

/*
 * Darshan Catalog: a static, single-page app.
 *
 * All dress information comes from a Google Sheet published as CSV
 * (settings.sheetCsvUrl). Whatever columns the sheet has are shown on the dress
 * page; only the columns listed under "sheet vocabulary" get special treatment.
 * The last good copy of the sheet is kept in the browser, so return visits show
 * the list instantly and the sheet is refreshed in the background.
 *
 * Photos come from Google Drive, fetched only when a dress (or night outfit) is opened:
 *   settings.dressesFolderId/<dress number>/*.jpg
 *   settings.nightOutfitsFolderId/<letter>/*.jpg
 *
 * Pages (hash routes, so GitHub Pages needs no server config):
 *   #/            list with search + filters
 *   #/dress/7     dress card + photo gallery
 *   #/night/E     night outfit photos + dresses that use it
 *   #/check       (not linked) problems in the sheet, for editors
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const ORIGINAL_MIME_OK = /^image\/(jpeg|png|webp|gif)$/; // browsers can't show HEIC originals
const CACHE_KEY = 'darshan:sheet:v1';

// ---------------------------------------------------------------- sheet vocabulary
// Header names are compared after fold() (lower case, no accents, letters and digits
// only), so "No.", "no" and "NO ." are the same column.

const COLUMNS = {
  number: ['no', 'number', 'dressno', 'dressnumber'],
  name: ['name', 'dressname'],
  jewellery: ['jewellery', 'jewelry', 'jewellerycolours', 'jewellerycolors', 'jewelrycolors'],
  backdrop: ['backdrop'],
  night: ['nightoutfits', 'nightoutfit', 'nightoutfitoptions'],
  weather: ['weathersuitability', 'weather', 'season'],
  location: ['location'],
};

// Kept in the sheet for editors; never shown in the app.
const HIDDEN_COLUMNS = ['repairrequirements', 'firstoffered', 'designedby', 'daynight'];

// Deity-set columns. Each cell lists items by code, optionally led by a metal
// ("Gold C, T"). A blank cell means none of the items.
const DEITY_SETS = {
  rk: 'Radha Krishna',
  jb: 'Jagannatha Baladeva',
  s: 'Subhadra',
  gngg: 'Gaura Nitai / Giriraja Govardhan',
};
const ITEMS = [
  { code: 'C', label: 'Crowns' },
  { code: 'T', label: 'Turban pieces' },
  { code: 'S', label: 'Suryas' },
];
const METALS = ['gold', 'silver'];

const LOCATION_NAMES = { tcr: 'Tottenham Court Road office' }; // explained in legends; pages show the code
const FADED_LOCATIONS = ['tcr']; // dimmed in the list: not at the temple

// Home-page filters, in display order. Several values can be picked in a group (a dress
// matches any of them); groups combine (a dress must match every group in use).
const FILTERS = [
  { id: 'location', label: 'Location' },
  // Always offered. "Hot" also finds dresses for both seasons, likewise "Cold"; "Both" finds only those.
  { id: 'weather', label: 'Weather', fixed: [
    { key: 'hot', label: 'Hot' }, { key: 'cold', label: 'Cold' }, { key: 'both', label: 'Both' }] },
  { id: 'tags', label: 'Tags' },
  { id: 'jewellery', label: 'Jewellery colour' },
];

const state = {
  model: null,       // built from the sheet by buildModel()
  source: null,      // { kind: 'saved' | 'live', at: ms }
  loadProblem: '',   // why the latest sheet wasn't used, if it wasn't
  settings: null,
  filters: { q: '', sel: Object.fromEntries(FILTERS.map((f) => [f.id, new Set()])) },
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

/** Comparison key: "Diamanté " and "diamante" -> "diamante"; "No." -> "no". */
function fold(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Tidies a cell: no-break spaces, odd dashes, repeated and edge spaces. */
function clean(s) {
  return String(s ?? '').normalize('NFC').replace(/\u00a0/g, ' ')
    .replace(/[\u2012-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * "yellow" -> "Yellow", "DIAMANTE" -> "Diamante". Short codes (AB, TCR) and
 * anything typed in mixed case stay exactly as typed.
 */
function tidyCase(s) {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (!letters) return s;
  const lower = s === s.toLowerCase();
  const upper = s === s.toUpperCase();
  if (upper && letters.length <= 3) return s;
  if (!lower && !upper) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (m, before, ch) => before + ch.toUpperCase());
}

/** "Silver and Emerald,  gold ," -> ["Silver", "Emerald", "Gold"], without repeats. */
function splitList(s, { words = false } = {}) {
  const sep = words ? /\s*(?:[,;&+]|\band\b)\s*/i : /\s*[,;]\s*/;
  const seen = new Set();
  const out = [];
  for (const part of clean(s).split(sep)) {
    const item = tidyCase(clean(part));
    const key = fold(item);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/**
 * Moves notes in brackets out of list items, so filters and the list use the plain value:
 * ["Gold (see garland colour)", "Red"] -> jewellery ["Gold", "Red"], jewelleryNotes { Gold: "see garland colour" }.
 */
function splitNotes(items) {
  const jewellery = [];
  const jewelleryNotes = {};
  items.forEach((item) => {
    const m = item.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    const base = m && clean(m[1]) ? clean(m[1]) : item;
    if (!jewellery.some((j) => fold(j) === fold(base))) jewellery.push(base);
    if (m && clean(m[1]) && clean(m[2])) jewelleryNotes[base] = clean(m[2]);
  });
  return { jewellery, jewelleryNotes };
}

/** "e, p ,i" -> ["E", "P", "I"]. */
function splitLetters(s) {
  return [...new Set(clean(s).toUpperCase().split(/[\s,;/]+/).filter(Boolean))];
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- sheet -> model

/** Minimal CSV parser: quoted fields, doubled quotes, commas/newlines inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Reads a deity-set cell such as "Gold C, T, S" into { C: 'Gold', T: 'Gold', S: 'Gold' }.
 * Anything it can't read with certainty (e.g. "Gold" alone: which items?) is marked
 * unclear and shown exactly as typed.
 */
function parseDeityCell(raw) {
  const text = clean(raw);
  const cell = { text, items: {}, unclear: false };
  if (!text) return cell; // blank: none of the items
  let metal = '';
  for (const token of text.split(/\s*[,;]\s*/).filter(Boolean)) {
    let codesHere = 0;
    for (const word of token.split(' ')) {
      const w = word.toLowerCase();
      if (METALS.includes(w)) {
        metal = tidyCase(w);
      } else if (ITEMS.some((it) => it.code.toLowerCase() === w)) {
        cell.items[w.toUpperCase()] = metal || '✓';
        codesHere++;
      } else {
        cell.unclear = true; // a word we don't know
      }
    }
    if (!codesHere) cell.unclear = true;
  }
  return cell;
}

/** "TCR" -> "Tottenham Court Road office"; codes without an explanation give ''. */
/**
 * Reads a weather cell however it was typed: "Hot", "Hot Weather", "summer", "Cold",
 * "Hot, Cold", "Hot & Cold", "Both", "All" -> { hot, cold }. Unknown text -> both false.
 */
function parseWeather(raw) {
  const t = clean(raw).toLowerCase();
  const both = /\b(both|all|any|all[- ]?year)\b/.test(t);
  return {
    text: clean(raw),
    hot: both || /\b(hot|summer|warm)\b/.test(t),
    cold: both || /\b(cold|winter|cool)\b/.test(t),
  };
}

function weatherLabel(w) {
  if (w.hot && w.cold) return 'Hot & Cold';
  if (w.hot) return 'Hot';
  if (w.cold) return 'Cold';
  return w.text; // not understood: shown as typed
}

function locationName(code) {
  return LOCATION_NAMES[fold(code)] || '';
}

/** Turns the CSV into dresses, filter options and a list of problems for #/check. */
function buildModel(csvText) {
  const rows = parseCsv(csvText);
  const headerAt = rows.findIndex((r) => r.some((c) => COLUMNS.number.includes(fold(c))));
  if (headerAt < 0) return { error: "couldn't find a 'No.' column in the sheet" };

  const taken = new Set();
  const columns = rows[headerAt].map((h, idx) => {
    const key = fold(h);
    let role = Object.keys(COLUMNS).find((r) => COLUMNS[r].includes(key));
    if (role && taken.has(role)) role = 'extra'; // a second "Name" column is just shown
    if (role) taken.add(role);
    else if (DEITY_SETS[key]) role = 'deity';
    else if (!key || HIDDEN_COLUMNS.includes(key)) role = 'hidden';
    else role = 'extra';
    return { idx, key, label: clean(h), role };
  });
  const colFor = (role) => columns.find((c) => c.role === role);

  const issues = {
    missingColumns: ['name', 'jewellery', 'backdrop', 'night', 'location']
      .filter((r) => !colFor(r)).map((r) => COLUMNS[r][0]),
    skipped: [], duplicates: [], unnamed: [], sparse: [], unclear: [], weather: [], badBackdrop: [], variants: [],
  };

  const dresses = [];
  const byId = new Map();
  rows.slice(headerAt + 1).forEach((r, i) => {
    const sheetRow = headerAt + 2 + i;
    if (!r.some((c) => clean(c))) return; // blank row
    const get = (role) => { const c = colFor(role); return c ? clean(r[c.idx]) : ''; };

    const idText = get('number');
    if (!/^\d+$/.test(idText)) {
      issues.skipped.push({ sheetRow, idText });
      return;
    }
    const id = Number(idText);
    if (byId.has(id)) {
      issues.duplicates.push({ sheetRow, id });
      return;
    }

    const rawName = get('name');
    if (!rawName) issues.unnamed.push(id);
    const name = rawName || `Dress ${id}`;
    const backdrop = get('backdrop');
    const locRaw = get('location');
    const location = LOCATION_NAMES[fold(locRaw)] ? locRaw.toUpperCase() : tidyCase(locRaw);

    const d = {
      id,
      name,
      tags: [...name.matchAll(/\(([^)]+)\)/g)].map((m) => tidyCase(clean(m[1]))).filter(Boolean),
      ...splitNotes(splitList(get('jewellery'), { words: true })),
      deity: columns.filter((c) => c.role === 'deity')
        .map((c) => ({ label: DEITY_SETS[c.key], code: c.label, ...parseDeityCell(r[c.idx]) })),
      backdrop,
      backdropRef: /^\d+$/.test(backdrop) ? Number(backdrop) : null,
      night: splitLetters(get('night')),
      weather: parseWeather(get('weather')),
      location,
      faded: FADED_LOCATIONS.includes(fold(location)),
      extras: columns.filter((c) => c.role === 'extra')
        .map((c) => ({ label: c.label, value: clean(r[c.idx]) })).filter((e) => e.value),
    };
    d.filterValues = {
      location: d.location ? [d.location] : [],
      weather: d.weather.hot && d.weather.cold ? ['Hot', 'Cold', 'Both']
        : d.weather.hot ? ['Hot'] : d.weather.cold ? ['Cold'] : [],
      tags: d.tags,
      jewellery: d.jewellery,
    };
    d.sparse = !d.jewellery.length && d.deity.every((c) => !c.text) && !d.backdrop && !d.night.length;

    if (d.sparse) issues.sparse.push(id);
    d.deity.filter((c) => c.unclear).forEach((c) => issues.unclear.push({ id, code: c.code, text: c.text }));
    if (d.weather.text && !d.weather.hot && !d.weather.cold) issues.weather.push({ id, text: d.weather.text });
    byId.set(id, d);
    dresses.push(d);
  });
  dresses.sort((a, b) => a.id - b.id);
  dresses.filter((d) => d.backdropRef !== null && !byId.has(d.backdropRef))
    .forEach((d) => issues.badBackdrop.push({ id: d.id, ref: d.backdropRef }));

  // Filter options: one button per folded value, labelled with its most common spelling.
  const options = {};
  const spellings = {}; // label -> fold key -> Map(spelling -> count)
  const tally = (label, values) => {
    const byKey = spellings[label] || (spellings[label] = new Map());
    values.forEach((v) => {
      const k = fold(v);
      if (!byKey.has(k)) byKey.set(k, new Map());
      byKey.get(k).set(v, (byKey.get(k).get(v) || 0) + 1);
    });
  };
  FILTERS.filter((f) => !f.fixed).forEach((f) => dresses.forEach((d) => tally(f.label, d.filterValues[f.id])));
  dresses.forEach((d) => d.backdrop && tally('Backdrop', [d.backdrop]));
  FILTERS.forEach((f) => {
    if (f.fixed) {
      options[f.id] = f.fixed;
      return;
    }
    options[f.id] = [...(spellings[f.label] || new Map())].map(([key, forms]) => ({
      key,
      label: [...forms].sort((a, b) => b[1] - a[1])[0][0],
    })).sort((a, b) => a.label.localeCompare(b.label));
  });

  // Same word spelled differently ("Diamante" / "Diamanté"), or singular/plural ("Gopi" / "Gopis").
  Object.entries(spellings).forEach(([label, byKey]) => {
    byKey.forEach((forms) => {
      if (forms.size > 1) issues.variants.push({ label, forms: [...forms.keys()], merged: true });
    });
    const stems = new Map();
    byKey.forEach((forms, key) => {
      const stem = key.replace(/s$/, '');
      if (!stems.has(stem)) stems.set(stem, []);
      stems.get(stem).push([...forms.keys()][0]);
    });
    stems.forEach((forms) => {
      if (forms.length > 1) issues.variants.push({ label, forms, merged: false });
    });
  });

  return { dresses, byId, columns, options, issues };
}

// ---------------------------------------------------------------- loading + saved copy

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (_) { return null; }
}

function writeCache(csv) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ csv, at: Date.now() })); } catch (_) { /* full / private */ }
}

async function fetchSheet(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error('the link returned a web page, not CSV (is the sheet still published?)');
  return text;
}

function useModel(model, source) {
  state.model = model;
  state.source = source;
  // Forget selections whose value no longer exists, so nobody gets stuck on an invisible filter.
  FILTERS.forEach((f) => {
    const keys = new Set(model.options[f.id].map((o) => o.key));
    [...state.filters.sel[f.id]].forEach((k) => keys.has(k) || state.filters.sel[f.id].delete(k));
  });
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

/** Draws the page for the current hash. `refresh` = same page, new data: keep scroll and focus. */
function route(refresh = false) {
  if (!refresh) {
    closeViewer();
    if (state.view === 'home') state.homeScroll = window.scrollY;
  }
  if (!state.model) return; // start() shows "Loading…" or the load error

  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const focusedSearch = refresh && document.activeElement?.id === 'search';

  if (parts[0] === 'dress' && parts[1]) {
    state.view = 'dress';
    renderDress(Number(parts[1]));
  } else if (parts[0] === 'night' && parts[1]) {
    state.view = 'night';
    renderNight(parts[1].toUpperCase());
  } else if (parts[0] === 'check') {
    state.view = 'check';
    renderCheck();
  } else {
    state.view = 'home';
    renderHome();
  }

  if (focusedSearch) {
    const input = document.getElementById('search');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
  if (!refresh) window.scrollTo(0, state.view === 'home' ? state.homeScroll : 0);
}

// ---------------------------------------------------------------- home

function chipGroup(group) {
  const options = state.model.options[group.id];
  if (!options.length) return '';
  const sel = state.filters.sel[group.id];
  const chips = options.map((o) => `
    <button type="button" class="chip${sel.has(o.key) ? ' on' : ''}" aria-pressed="${sel.has(o.key)}"
            data-group="${group.id}" data-value="${esc(o.key)}">${esc(o.label)}</button>`).join('');
  return `<div class="chip-group" role="group" aria-label="${esc(group.label)}">
    <span class="chip-label">${esc(group.label)}</span>${chips}</div>`;
}

function filtersActive() {
  return Boolean(state.filters.q.trim()) || FILTERS.some((g) => state.filters.sel[g.id].size);
}

function renderHome() {
  const f = state.filters;
  app.innerHTML = `
    <section class="controls panel">
      <input id="search" type="search" placeholder="Search by number or name"
             value="${esc(f.q)}" autocomplete="off">
      ${FILTERS.map(chipGroup).join('')}
      <button type="button" id="clear" class="clear-filters" hidden>Clear all filters</button>
    </section>
    ${homeLegend()}
    <p id="count" class="count"></p>
    <ul id="list" class="list"></ul>`;

  document.getElementById('search').addEventListener('input', (e) => {
    f.q = e.target.value;
    updateList();
  });
  app.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
    const sel = f.sel[chip.dataset.group];
    const value = chip.dataset.value;
    if (sel.has(value)) sel.delete(value); else sel.add(value); // tap again to unselect
    chip.classList.toggle('on', sel.has(value));
    chip.setAttribute('aria-pressed', String(sel.has(value)));
    updateList();
  }));
  document.getElementById('clear').addEventListener('click', () => {
    f.q = '';
    FILTERS.forEach((g) => f.sel[g.id].clear());
    renderHome();
  });
  updateList();
}

/** "Note: the dresses shown faded below are currently at the TCR (Tottenham Court Road office)." */
function homeLegend() {
  const away = [...new Set(state.model.dresses.filter((d) => d.faded).map((d) => d.location))];
  if (!away.length) return '';
  const where = away.map((code) => (locationName(code) ? `${code} (${locationName(code)})` : code)).join(' or ');
  return `<p class="legend">Note: the dresses shown faded below are currently at the ${esc(where)}.</p>`;
}

function matches(d) {
  const f = state.filters;
  const q = fold(f.q);
  if (q && !String(d.id).startsWith(q) && !fold(d.name).includes(q)) return false;
  return FILTERS.every((g) => {
    const sel = f.sel[g.id];
    return !sel.size || d.filterValues[g.id].some((v) => sel.has(fold(v)));
  });
}

function updateList() {
  const m = state.model;
  const shown = m.dresses.filter(matches);
  document.getElementById('clear').hidden = !filtersActive();
  let count = `${shown.length} of ${m.dresses.length} dresses`;
  if (state.loadProblem && state.source?.kind === 'saved') count += ` · saved copy from ${fmtDate(state.source.at)}`;
  document.getElementById('count').textContent = count;
  document.getElementById('list').innerHTML = shown.map((d) => `
      <li><a class="row${d.faded ? ' faded' : ''}" href="#/dress/${d.id}">
        <span class="num">${esc(d.id)}</span>
        <span class="row-main">
          <span class="row-name">${esc(d.name)}</span>
          ${d.jewellery.length ? `<span class="row-meta">${esc(d.jewellery.join(', '))}</span>` : ''}
        </span>
        ${d.faded ? `<span class="sr-only">(at ${esc(d.location)})</span>` : ''}
      </a></li>`).join('') || '<li class="status">No dresses match these filters.</li>';
}

// ---------------------------------------------------------------- dress

function deityTable(d) {
  if (!d.deity.length || d.deity.every((c) => !c.text)) return '';
  const head = ITEMS.map((it) => `<th scope="col">${esc(it.label)}</th>`).join('');
  const body = d.deity.map((c) => {
    const cells = c.unclear
      ? `<td colspan="${ITEMS.length}" class="as-typed">${esc(c.text)}</td>`
      : ITEMS.map((it) => (c.items[it.code]
        ? `<td>${esc(c.items[it.code])}</td>`
        : '<td class="none"><span aria-hidden="true">–</span><span class="sr-only">Not available</span></td>')).join('');
    return `<tr><th scope="row"><abbr title="${esc(c.label)}">${esc(c.code)}</abbr></th>${cells}</tr>`;
  }).join('');
  return `<table class="jewelry deity"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Bottom-of-page key for the short codes used on a dress page (RK, JB, ..., TCR). */
function dressLegend(d) {
  const entries = [];
  if (!d.deity.every((c) => !c.text)) d.deity.forEach((c) => entries.push([c.code, c.label]));
  if (locationName(d.location)) entries.push([d.location, locationName(d.location)]);
  if (!entries.length) return '';
  return `<footer class="page-legend"><h2>Key</h2><dl>${entries.map(([k, v]) =>
    `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></footer>`;
}

function nightLinks(letters) {
  return letters.map((l) => `<a class="pill" href="#/night/${encodeURIComponent(l)}">${esc(l)}</a>`).join(' ');
}

function backdropHtml(d) {
  if (d.backdropRef === null) return esc(d.backdrop);
  const target = state.model.byId.get(d.backdropRef);
  return target
    ? `Same as <a class="pill" href="#/dress/${target.id}">${esc(target.id)} · ${esc(target.name)}</a>`
    : `Same as dress ${esc(d.backdropRef)}`;
}

function renderDress(id) {
  const m = state.model;
  const d = m.byId.get(id);
  if (!d) {
    app.innerHTML = `<p class="status">Dress ${esc(id)} not found. <a href="#/">Back to all dresses</a></p>`;
    return;
  }
  const i = m.dresses.indexOf(d);
  const prev = m.dresses[i - 1];
  const next = m.dresses[i + 1];
  const more = [
    d.weather.text ? ['Weather', esc(weatherLabel(d.weather))] : null,
    ...d.extras.map((e) => [esc(e.label), esc(e.value)]),
  ].filter(Boolean);

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
        ${d.location ? `<span class="sticker ${d.faded ? 'sticker-away' : 'sticker-both'}">
          <span class="sticker-icon" aria-hidden="true">⌂</span>
          <span><b>${esc(d.location)}</b></span></span>` : ''}
      </header>
      ${d.tags.length ? `<p class="tags">${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
      ${d.jewellery.length ? `
        <section class="prime">
          <h2 class="prime-label">Jewellery colours</h2>
          <p class="jewels">${d.jewellery.map((j) => `<span class="jewel">${esc(j)}${d.jewelleryNotes[j]
            ? ` <small class="jewel-note">(${esc(d.jewelleryNotes[j])})</small>` : ''}</span>`).join('')}</p>
        </section>` : ''}
      ${deityTable(d)}
      <dl class="facts">
        ${d.backdrop ? `<dt>Backdrop</dt><dd>${backdropHtml(d)}</dd>` : ''}
        ${d.night.length ? `<dt>Night outfit options</dt><dd>${nightLinks(d.night)}</dd>` : ''}
      </dl>
      ${d.sparse ? '<p class="soon">More details coming soon.</p>' : ''}
      ${more.length ? `<dl class="facts more">${more.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    </article>
    <section class="photos">
      <h2>Photos</h2>
      <div id="gallery" class="gallery"></div>
    </section>
    ${dressLegend(d)}`;

  loadGallery(state.settings?.dressesFolderId, String(d.id));
}

// ---------------------------------------------------------------- night outfit

function renderNight(letter) {
  const users = state.model.dresses.filter((d) => d.night.includes(letter));
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

// ---------------------------------------------------------------- check (for sheet editors)

function renderCheck() {
  const m = state.model;
  const is = m.issues;
  const link = (id) => `<a href="#/dress/${id}">${esc(id)}</a>`;
  const section = (title, items, fmt, hint = '') => `
    <section class="check-sec">
      <h2>${esc(title)} <span class="check-count${items.length ? ' has' : ''}">${items.length}</span></h2>
      ${hint ? `<p class="check-hint">${hint}</p>` : ''}
      ${items.length ? `<ul>${items.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>` : '<p class="ok">✓ None</p>'}
    </section>`;
  const roleText = { number: 'dress number', name: 'title', jewellery: 'jewellery colours (filter)',
    backdrop: 'backdrop', night: 'night outfit links', weather: 'weather (filter)', location: 'location (filter)',
    deity: 'crowns / turbans / suryas table', hidden: 'not shown', extra: 'shown under "more details"' };
  const source = state.source?.kind === 'live'
    ? `loaded from the sheet at ${new Date(state.source.at).toLocaleTimeString('en-GB')}`
    : `saved copy from ${fmtDate(state.source.at)}`;

  app.innerHTML = `
    <nav class="crumbs"><a href="#/">← All dresses</a></nav>
    <article class="card check">
      <h1>Sheet check</h1>
      <p class="facts-line">${m.dresses.length} dresses · ${esc(source)}</p>
      ${state.loadProblem ? `<p class="status error">Latest sheet not used: ${esc(state.loadProblem)}</p>` : ''}
      ${is.missingColumns.length ? `<p class="status error">Columns not found: ${esc(is.missingColumns.join(', '))}</p>` : ''}
      ${section('Rows skipped (no dress number)', is.skipped,
        (x) => `Sheet row ${x.sheetRow}${x.idText ? `: “${esc(x.idText)}”` : ''}`)}
      ${section('Repeated numbers (first row used)', is.duplicates,
        (x) => `Sheet row ${x.sheetRow} repeats ${link(x.id)}`)}
      ${section('No name', is.unnamed, link)}
      ${section('Almost no details', is.sparse, (id) => `${link(id)} · ${esc(m.byId.get(id).name)}`)}
      ${section('Crowns / turbans / suryas shown as typed', is.unclear,
        (x) => `${link(x.id)} · ${esc(x.code)}: “${esc(x.text)}”`,
        'Use codes C, T, S, optionally after Gold or Silver, e.g. “Gold C, T”.')}
      ${section('Weather not understood (no filter)', is.weather, (x) => `${link(x.id)} · “${esc(x.text)}”`,
        'Write Hot, Cold, or Both.')}
      ${section('Backdrop points to a missing dress', is.badBackdrop, (x) => `${link(x.id)} → ${esc(x.ref)}`)}
      ${section('Possible duplicate spellings', is.variants,
        (x) => `${esc(x.label)}: ${x.forms.map((f) => `“${esc(f)}”`).join(' / ')}${x.merged ? ' (already treated as one)' : ''}`)}
      <section class="check-sec">
        <h2>Columns</h2>
        <ul>${m.columns.filter((c) => c.label).map((c) =>
          `<li><b>${esc(c.label)}</b>: ${esc(roleText[c.role])}</li>`).join('')}</ul>
      </section>
    </article>`;
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

function showLoadProblem(problem) {
  state.loadProblem = problem;
  console.warn('Catalog data:', problem);
  if (!state.model) {
    app.innerHTML = `<p class="status error">Could not load the catalog (${esc(problem)}). Please try again later.</p>`;
  } else if (state.view === 'home' || state.view === 'check') {
    route(true); // show the "saved copy" note
  }
}

async function start() {
  window.addEventListener('hashchange', () => route());
  try {
    state.settings = await loadJson('settings.json');
  } catch (_) {
    state.settings = null;
  }

  // 1. Saved copy first: return visits show the catalog straight away.
  const saved = readCache();
  if (saved?.csv) {
    const m = buildModel(saved.csv);
    if (!m.error && m.dresses.length) {
      useModel(m, { kind: 'saved', at: saved.at });
      route();
    }
  }

  // 2. Then the live sheet. A sheet that looks broken (no 'No.' column, no dresses, or
  //    fewer than half as many as before) is not used and doesn't replace the saved copy.
  const url = state.settings?.sheetCsvUrl;
  if (!url) {
    showLoadProblem('settings.json has no sheetCsvUrl');
    return;
  }
  try {
    const csv = await fetchSheet(url);
    const m = buildModel(csv);
    const before = state.model?.dresses.length || 0;
    const problem = m.error
      || (!m.dresses.length && 'the sheet has no dress rows')
      || (m.dresses.length < before / 2 && `the sheet now has only ${m.dresses.length} dresses (was ${before})`);
    if (problem) {
      showLoadProblem(problem);
      return;
    }
    const first = !state.model;
    const changed = csv !== saved?.csv;
    writeCache(csv);
    useModel(m, { kind: 'live', at: Date.now() });
    if (first) route();
    else if (changed || state.view === 'check') route(true);
  } catch (err) {
    showLoadProblem(`could not load the sheet: ${err.message}`);
  }
}

start();
