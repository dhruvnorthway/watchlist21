import { ID_RE, normPrefs, trimOpened, signalOf, rank, compose, inDept, fmtDur } from './feed.js';

const KEY = 'watchlist.prefs.v1';
const PAGE = 24;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let data = null;
let byId = new Map();
let loadError = '';
let prefs = readPrefs();
let dept = 0;
let limit = PAGE;
let confirmClear = false;
let undo = null;
let toastTimer = 0;

/* ---------- saved feedback (this browser only) ---------- */
function readPrefs() {
  try {
    return normPrefs(JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch (e) {
    return normPrefs(null);
  }
}
function savePrefs() {
  trimOpened(prefs);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch (e) {
    /* storage unavailable: feedback lasts until the page closes */
  }
}

/* ---------- data ---------- */
function cleanData(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('The data file is not in the expected format.');
  const departments = (Array.isArray(raw.departments) ? raw.departments : [])
    .filter((d) => d && Number.isInteger(d.id) && d.id >= 1 && d.id <= 9)
    .map((d) => ({ id: d.id, short: String(d.short || ''), name: String(d.name || ''), alloc: +d.alloc || 0 }));
  const videos = (Array.isArray(raw.videos) ? raw.videos : [])
    .filter((v) => v && ID_RE.test(String(v.id)) && typeof v.title === 'string' && +v.dur > 0 && Number.isInteger(v.dept) && v.dept >= 1 && v.dept <= 9)
    .map((v) => ({
      id: v.id,
      title: v.title,
      channel: String(v.channel || ''),
      channelId: String(v.channelId || ''),
      dur: +v.dur,
      dept: v.dept,
      topics: Array.isArray(v.topics) ? v.topics.filter((t) => /^\d-\d+$/.test(String(t))).slice(0, 3) : [],
      published: String(v.published || ''),
      score: Math.min(1, Math.max(0, +v.score || 0)),
      quality: Math.max(0, Math.min(100, +v.quality || 0)),
      qualityConfidence: String(v.qualityConfidence || 'low'),
      qualityBasis: String(v.qualityBasis || 'legacy'),
      trusted: !!v.trusted,
    }));
  const updated = raw.updated && isFinite(Date.parse(raw.updated)) ? raw.updated : null;
  return { updated, departments, modes: raw.modes && typeof raw.modes === 'object' ? raw.modes : {}, videos };
}

async function load() {
  try {
    const res = await fetch('data/videos.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('The list could not be loaded (' + res.status + ').');
    data = cleanData(await res.json());
    byId = new Map(data.videos.map((v) => [v.id, v]));
  } catch (e) {
    loadError = e instanceof SyntaxError ? 'The data file could not be read.' : (e && e.message) || 'The list could not be loaded.';
  }
  readHash();
  render();
}

function readHash() {
  const m = /^#d([1-9])$/.exec(location.hash);
  dept = m && data && data.departments.some((d) => d.id === +m[1]) ? +m[1] : 0;
}

const deptOf = (id) => (data && data.departments.find((d) => d.id === id)) || { short: 'Other', name: 'Other' };

/* ---------- drawing ---------- */
function cardHTML(x) {
  const v = x.v;
  const url = 'https://www.youtube.com/watch?v=' + v.id;
  const d = deptOf(v.dept);
  const tag = x.mode === 'B' ? 'Trusted channel' : x.mode === 'C' ? 'Unexpected' : '';
  const qualityTag = v.qualityBasis === 'ai_metadata' ? 'AI metadata' : v.quality ? 'Quality screened' : ''; 
  return (
    '<article class="card' + (x.opened ? ' seen' : '') + '" data-id="' + v.id + '">' +
    '<a class="thumb yt" href="' + url + '" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true" data-id="' + v.id + '">' +
    '<span class="ph">' + esc(d.short) + '</span>' +
    '<img src="https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg" alt="" width="320" height="180" loading="lazy" decoding="async" referrerpolicy="no-referrer">' +
    '<span class="dur">' + fmtDur(v.dur) + '</span></a>' +
    '<h2 class="title"><a class="yt" href="' + url + '" target="_blank" rel="noopener noreferrer" data-id="' + v.id + '">' + esc(v.title) + '</a></h2>' +
    '<p class="meta"><span>' + esc(v.channel) + '</span><span>' + esc(d.short) + '</span>' + (tag ? '<span class="tag">' + tag + '</span>' : '') + (qualityTag ? '<span class="tag">' + qualityTag + '</span>' : '') + '</p>' +
    '<div class="acts">' +
    '<button type="button" class="act" data-act="like" data-id="' + v.id + '" aria-pressed="' + (x.liked ? 'true' : 'false') + '">More like this</button>' +
    '<button type="button" class="act" data-act="hide" data-id="' + v.id + '">Not for me</button>' +
    '</div></article>'
  );
}

function renderChips(total, counts) {
  const box = $('chips');
  const left = box.scrollLeft;
  const items = [{ id: 0, short: 'All', n: total }].concat(data.departments.map((d) => ({ id: d.id, short: d.short, n: counts[d.id] || 0 })));
  box.innerHTML = items
    .map((c) => '<button type="button" class="chip" data-act="dept" data-d="' + c.id + '" aria-pressed="' + (dept === c.id ? 'true' : 'false') + '">' + esc(c.short) + ' <i>' + c.n + '</i></button>')
    .join('');
  box.scrollLeft = left;
}

function renderFoot() {
  const any = Object.keys(prefs.liked).length + Object.keys(prefs.hidden).length + Object.keys(prefs.opened).length > 0;
  let h = '<p>Ranked on your interests, depth and your feedback. Views, likes and subscriber counts are never used. Feedback is saved in this browser only.</p>';
  if (any) {
    h += confirmClear
      ? '<span>Clear all feedback and opened history?</span><button type="button" class="btn" data-act="clear-yes">Clear</button><button type="button" class="btn alt" data-act="clear-no">Cancel</button>'
      : '<button type="button" class="linkbtn" data-act="clear">Clear feedback</button>';
  }
  $('foot').innerHTML = h;
}

// Filters, counts and the status line. Does not touch the cards.
function chrome() {
  const ranked = rank(data.videos, prefs, data);
  const counts = {};
  ranked.forEach((x) => (counts[x.v.dept] = (counts[x.v.dept] || 0) + 1));
  renderChips(ranked.length, counts);
  const when = data.updated
    ? new Date(data.updated).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
  $('status').textContent = data.updated ? 'Updated ' + when + ' · ' + ranked.length + (ranked.length === 1 ? ' video' : ' videos') : 'Not updated yet';
  renderFoot();
  return ranked;
}

function render() {
  const main = $('main');
  if (loadError) {
    $('status').textContent = '';
    $('chips').innerHTML = '';
    $('foot').innerHTML = '';
    main.innerHTML = '<div class="empty"><h2>The list could not be loaded</h2><p>' + esc(loadError) + '</p><p>If you opened this page from a file, serve the folder instead with python3 -m http.server 8080.</p></div>';
    return;
  }
  if (!data) return;
  const ranked = chrome();
  if (!data.videos.length) {
    main.innerHTML =
      '<div class="empty"><h2>No videos yet</h2>' +
      '<p>Your list is filled by an update that runs twice a day and finds videos matching your interests. It has not run yet.</p>' +
      '<ol><li>Add your YouTube API key as a repository secret named YT_API_KEY. The README shows how.</li>' +
      '<li>On GitHub open Actions, choose Update and publish, then Run workflow.</li>' +
      '<li>Reload this page when it finishes.</li></ol></div>';
    return;
  }
  if (!ranked.length) {
    main.innerHTML = '<div class="empty"><h2>You have hidden everything</h2><p>Every video is hidden. Clear your feedback to bring them back.</p><button type="button" class="btn" data-act="clear-yes">Clear feedback</button></div>';
    return;
  }
  const list = dept ? inDept(ranked, dept) : compose(ranked, data);
  if (!list.length) {
    main.innerHTML = '<div class="empty"><h2>Nothing in ' + esc(deptOf(dept).short) + ' yet</h2><p>The update has not found a video for this department that passes your filters. It searches every department over time.</p><button type="button" class="btn" data-act="dept" data-d="0">Show all</button></div>';
    return;
  }
  const shown = list.slice(0, limit);
  main.innerHTML =
    '<div class="grid">' + shown.map(cardHTML).join('') + '</div>' +
    (list.length > shown.length ? '<div class="more"><button type="button" class="btn alt" data-act="more">Show more</button></div>' : '');
}

/* ---------- actions ---------- */
function toast(msg, label, fn) {
  const el = $('toast');
  undo = fn || null;
  el.innerHTML = '<span>' + esc(msg) + '</span>' + (label && fn ? '<button type="button" data-act="undo">' + esc(label) + '</button>' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    undo = null;
  }, 6000);
}

function markOpened(id) {
  if (!ID_RE.test(id || '') || prefs.opened[id]) return;
  prefs.opened[id] = Date.now();
  savePrefs();
  document.querySelectorAll('.card[data-id="' + id + '"]').forEach((c) => c.classList.add('seen'));
  renderFoot();
}

function hideVideo(id) {
  const v = byId.get(id);
  if (!v) return;
  prefs.hidden[id] = signalOf(v);
  delete prefs.liked[id];
  savePrefs();
  const card = document.querySelector('.card[data-id="' + id + '"]');
  const next = card && (card.nextElementSibling || card.previousElementSibling);
  if (card) card.remove();
  chrome();
  if (!document.querySelector('.card')) render();
  else if (next && next.querySelector) {
    const a = next.querySelector('.title a');
    if (a) a.focus({ preventScroll: true });
  }
  toast('Hidden from your list.', 'Undo', () => {
    delete prefs.hidden[id];
    savePrefs();
    render();
  });
}

function goDept(id) {
  dept = id;
  limit = PAGE;
  history.pushState(null, '', id ? '#d' + id : location.pathname + location.search);
  render();
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const yt = e.target.closest && e.target.closest('a.yt');
  if (yt) {
    markOpened(yt.dataset.id);
    return;
  }
  const t = e.target.closest && e.target.closest('[data-act]');
  if (!t) return;
  const id = t.dataset.id;
  switch (t.dataset.act) {
    case 'like': {
      const v = byId.get(id);
      if (!v) break;
      const on = !prefs.liked[id];
      if (on) prefs.liked[id] = signalOf(v);
      else delete prefs.liked[id];
      savePrefs();
      t.setAttribute('aria-pressed', on ? 'true' : 'false');
      toast(on ? 'Noted. You will see more like this.' : 'Removed.');
      break;
    }
    case 'hide':
      hideVideo(id);
      break;
    case 'dept':
      goDept(+t.dataset.d);
      break;
    case 'more':
      limit += PAGE;
      render();
      break;
    case 'undo': {
      const f = undo;
      $('toast').hidden = true;
      undo = null;
      if (f) f();
      break;
    }
    case 'clear':
      confirmClear = true;
      renderFoot();
      break;
    case 'clear-no':
      confirmClear = false;
      renderFoot();
      break;
    case 'clear-yes':
      prefs = normPrefs(null);
      confirmClear = false;
      savePrefs();
      render();
      toast('Feedback cleared.');
      break;
  }
});

document.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const yt = e.target.closest && e.target.closest('a.yt');
  if (yt) markOpened(yt.dataset.id);
});

// A thumbnail that fails to load leaves the department label showing instead.
document.addEventListener(
  'error',
  (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.closest && t.closest('.thumb')) t.hidden = true;
  },
  true,
);

function onNav() {
  readHash();
  limit = PAGE;
  if (data) render();
}
window.addEventListener('popstate', onNav);
window.addEventListener('hashchange', onNav);

load();
