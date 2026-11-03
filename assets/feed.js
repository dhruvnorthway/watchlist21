// Ordering the feed in the browser: your feedback nudges the scores the update job produced.
// Pure functions, no DOM, so they can be tested in Node.

export const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function squash(x) {
  return x / (Math.abs(x) + 3);
}

export function emptyPrefs() {
  return { liked: {}, hidden: {}, opened: {} };
}

function cleanSignals(o, max) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const id of Object.keys(o).slice(0, max)) {
    if (!ID_RE.test(id)) continue;
    const e = o[id] || {};
    out[id] = { c: String(e.c || '').slice(0, 80), t: Array.isArray(e.t) ? e.t.filter((x) => /^\d-\d+$/.test(String(x))).slice(0, 3) : [] };
  }
  return out;
}

export function normPrefs(raw) {
  const p = emptyPrefs();
  if (!raw || typeof raw !== 'object') return p;
  p.liked = cleanSignals(raw.liked, 2000);
  p.hidden = cleanSignals(raw.hidden, 2000);
  if (raw.opened && typeof raw.opened === 'object') {
    for (const id of Object.keys(raw.opened).slice(0, 3000)) if (ID_RE.test(id)) p.opened[id] = +raw.opened[id] || 0;
  }
  return p;
}

// Keep the opened list from growing forever: drop the oldest beyond the limit.
export function trimOpened(prefs, max = 1500) {
  const ids = Object.keys(prefs.opened);
  if (ids.length <= max) return;
  ids.sort((a, b) => prefs.opened[a] - prefs.opened[b]).slice(0, ids.length - max).forEach((id) => delete prefs.opened[id]);
}

export function signalOf(v) {
  return { c: v.channelId || v.channel || '', t: (v.topics || []).slice(0, 3) };
}

// Likes add to a channel and its topics. Hiding a video subtracts a little less from topics than from its channel,
// so one "not for me" can never remove a whole subject.
export function affinity(prefs) {
  const ch = {};
  const tp = {};
  for (const e of Object.values(prefs.liked)) {
    ch[e.c] = (ch[e.c] || 0) + 1;
    e.t.forEach((t) => (tp[t] = (tp[t] || 0) + 1));
  }
  for (const e of Object.values(prefs.hidden)) {
    ch[e.c] = (ch[e.c] || 0) - 1;
    e.t.forEach((t) => (tp[t] = (tp[t] || 0) - 0.5));
  }
  return { ch, tp };
}

// Returns every video that is not hidden, each with its final score. Opened videos are flagged.
export function rank(videos, prefs, meta) {
  const aff = affinity(prefs);
  const alloc = {};
  let maxA = 1;
  (meta.departments || []).forEach((d) => {
    alloc[d.id] = +d.alloc || 0;
    if (alloc[d.id] > maxA) maxA = alloc[d.id];
  });
  const out = [];
  for (const v of videos) {
    if (prefs.hidden[v.id]) continue;
    const key = v.channelId || v.channel || '';
    const tps = (v.topics || []).map((t) => squash(aff.tp[t] || 0));
    const topicAff = tps.length ? tps.reduce((a, b) => a + b, 0) / tps.length : 0;
    const chanAff = squash(aff.ch[key] || 0);
    const share = (alloc[v.dept] || 0) / maxA;
    const final = (v.score + 0.15 * topicAff + 0.12 * chanAff) * (0.8 + 0.2 * share);
    out.push({
      v,
      final,
      chanAff,
      topicAff,
      share,
      opened: Object.prototype.hasOwnProperty.call(prefs.opened, v.id),
      liked: !!prefs.liked[v.id],
    });
  }
  out.sort((a, b) => b.final - a.final || String(b.v.published).localeCompare(String(a.v.published)));
  return out;
}

// Slot order for the three discovery modes, spread evenly: with 50/25/25 it repeats A B C A.
export function pattern(modes, n = 20) {
  let w = [+modes.personal || 0, +modes.trusted || 0, +modes.unexpected || 0];
  let total = w[0] + w[1] + w[2];
  if (!(total > 0)) {
    w = [50, 25, 25];
    total = 100;
  }
  const names = ['A', 'B', 'C'];
  const count = [0, 0, 0];
  const out = [];
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestDef = -Infinity;
    for (let m = 0; m < 3; m++) {
      const def = (w[m] / total) * (i + 1) - count[m];
      if (def > bestDef + 1e-9) {
        bestDef = def;
        best = m;
      }
    }
    count[best]++;
    out.push(names[best]);
  }
  return out;
}

// The For You order: half personal picks, a quarter from trusted channels, a quarter unexpected finds
// (the best videos from the departments you weight least). Opened videos go to the end.
export function compose(ranked, meta) {
  const fresh = ranked.filter((x) => !x.opened);
  const opened = ranked.filter((x) => x.opened);
  const A = fresh;
  const B = fresh.filter((x) => x.v.trusted || x.chanAff > 0);
  const C = fresh
    .map((x) => ({ x, s: x.v.score * (1.3 - x.share) - 0.1 * x.topicAff }))
    .sort((a, b) => b.s - a.s)
    .map((o) => o.x);
  const pools = { A, B, C };
  const idx = { A: 0, B: 0, C: 0 };
  const used = new Set();
  const take = (m) => {
    const p = pools[m];
    while (idx[m] < p.length && used.has(p[idx[m]].v.id)) idx[m]++;
    return idx[m] < p.length ? p[idx[m]] : null;
  };
  const slots = pattern(meta.modes || {}, 20);
  const out = [];
  let i = 0;
  while (out.length < fresh.length) {
    const m = slots[i % slots.length];
    i++;
    let pick = take(m);
    let mode = m;
    if (!pick) {
      pick = take('A') || take('B') || take('C');
      mode = 'A';
    }
    if (!pick) break;
    used.add(pick.v.id);
    out.push({ ...pick, mode });
  }
  return out.concat(opened.map((x) => ({ ...x, mode: 'A' })));
}

export function inDept(ranked, dept) {
  const list = ranked.filter((x) => x.v.dept === dept);
  return list.filter((x) => !x.opened).concat(list.filter((x) => x.opened)).map((x) => ({ ...x, mode: 'A' }));
}

export function fmtDur(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = Math.floor(s % 60);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
}
