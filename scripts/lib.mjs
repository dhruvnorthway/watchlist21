// Filtering, matching and scoring. Pure functions, no network, no file access.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// ISO 8601 duration such as PT1H2M3S to seconds. Returns 0 when it cannot be read.
export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || ''));
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

export function compile(cfg) {
  const topics = [];
  for (const d of cfg.departments) {
    d.topics.forEach((t, i) => {
      topics.push({
        id: `${d.id}-${i}`,
        dept: d.id,
        name: t.name,
        q: t.q,
        regs: t.k.map((k) => ({ k, re: new RegExp('(^|[^a-z0-9])' + esc(k.toLowerCase())) })),
      });
    });
  }
  return {
    cfg,
    s: cfg.settings,
    topics,
    exclude: cfg.excludeTitle.map((r) => new RegExp(r, 'i')),
    click: cfg.clickbaitPhrases.map((r) => new RegExp(r, 'i')),
    trusted: new Set((cfg.trustedChannels || []).map((c) => c.id).filter(Boolean)),
  };
}

// Convert a YouTube Data API video resource into the flat shape used below.
export function toItem(r) {
  const sn = r.snippet || {};
  const cd = r.contentDetails || {};
  const st = r.status || {};
  const rr = cd.regionRestriction || {};
  return {
    id: String(r.id || ''),
    title: decode(sn.title),
    desc: String(sn.description || ''),
    tags: Array.isArray(sn.tags) ? sn.tags : [],
    channel: decode(sn.channelTitle),
    channelId: sn.channelId || '',
    published: sn.publishedAt || '',
    dur: parseDuration(cd.duration),
    caption: cd.caption === 'true',
    live: sn.liveBroadcastContent || 'none',
    privacy: st.privacyStatus || 'public',
    blocked: Array.isArray(rr.blocked) ? rr.blocked : null,
    allowed: Array.isArray(rr.allowed) ? rr.allowed : null,
    audioLang: sn.defaultAudioLanguage || sn.defaultLanguage || '',
  };
}

// Which of the user's topics does this video belong to? Title hit = 2 points, description or tag hit = 1.
export function topicMatches(item, model) {
  const title = norm(item.title);
  const body = norm(item.desc.slice(0, 2000) + ' ' + item.tags.join(' '));
  const out = [];
  for (const t of model.topics) {
    let score = 0;
    for (const { re } of t.regs) {
      if (re.test(title)) score += 2;
      else if (re.test(body)) score += 1;
    }
    if (score >= model.s.minTopicScore) out.push({ id: t.id, dept: t.dept, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 3);
}

export function clickbaitSignals(title, model) {
  const t = String(title || '');
  let n = 0;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.55) n++;
  if (/[!?]{2,}/.test(t) || (t.match(/!/g) || []).length >= 2) n++;
  if ((t.match(/\p{Extended_Pictographic}/gu) || []).length >= 2) n++;
  if (model.click.some((re) => re.test(t))) n++;
  return n;
}

export function chapterCount(desc) {
  return (String(desc).match(/^\s*[(\[]?\d{1,2}:\d{2}(?::\d{2})?[)\]]?\s+\S/gm) || []).length;
}

// Returns { ok: true, rec } or { ok: false, why }.
export function evaluate(item, model, nowMs) {
  const s = model.s;
  if (!/^[A-Za-z0-9_-]{11}$/.test(item.id)) return { ok: false, why: 'badid' };
  if (item.privacy !== 'public') return { ok: false, why: 'notpublic' };
  if (item.live !== 'none') return { ok: false, why: 'live' };
  if (item.blocked && item.blocked.includes(s.region)) return { ok: false, why: 'region' };
  if (item.allowed && !item.allowed.includes(s.region)) return { ok: false, why: 'region' };
  if (item.audioLang) {
    const l = item.audioLang.toLowerCase().slice(0, 2);
    if (!s.allowedAudioLanguages.includes(l)) return { ok: false, why: 'language' };
  }
  if (!item.title || !item.channel) return { ok: false, why: 'nometa' };
  const mins = item.dur / 60;
  if (item.dur <= 60) return { ok: false, why: 'short' };
  if (mins < s.minMinutes) return { ok: false, why: 'tooshort' };
  if (mins > s.maxMinutes) return { ok: false, why: 'toolong' };
  if (model.exclude.some((re) => re.test(item.title))) return { ok: false, why: 'excluded' };
  const cb = clickbaitSignals(item.title, model);
  if (cb >= 2) return { ok: false, why: 'clickbait' };
  const matches = topicMatches(item, model);
  if (!matches.length) return { ok: false, why: 'offtopic' };

  const durScore = mins < 25 ? 0.5 + (0.5 * (mins - s.minMinutes)) / (25 - s.minMinutes) : mins <= 120 ? 1 : 0.9;
  const depth = Math.min(
    1,
    0.8 * durScore + (chapterCount(item.desc) >= 4 ? 0.1 : 0) + (item.desc.length >= 600 ? 0.05 : 0) + (item.caption ? 0.05 : 0),
  );
  const relevance = Math.min(1, matches[0].score / 6);
  const ageDays = Date.parse(item.published) ? Math.max(0, (nowMs - Date.parse(item.published)) / 864e5) : 180;
  const recency = Math.pow(0.5, ageDays / 180);
  const trusted = model.trusted.has(item.channelId);
  const raw = 0.36 * relevance + 0.36 * depth + 0.08 * recency + (trusted ? 0.2 : 0) - 0.15 * cb;
  const score = Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000;

  return {
    ok: true,
    rec: {
      id: item.id,
      title: item.title,
      channel: item.channel,
      channelId: item.channelId,
      dur: item.dur,
      dept: matches[0].dept,
      topics: matches.map((m) => m.id),
      published: item.published,
      score,
      trusted,
    },
  };
}

// Keep the best `max` videos. A video keeps the date it was first added.
export function merge(existing, fresh, nowIso, max) {
  const prev = new Map(existing.map((v) => [v.id, v]));
  const out = fresh.map((v) => ({ ...v, added: (prev.get(v.id) && prev.get(v.id).added) || nowIso }));
  out.sort((a, b) => b.score - a.score || String(b.published).localeCompare(String(a.published)));
  return out.slice(0, max);
}

// The topics searched least recently go first, so every topic gets its turn.
export function pickTopics(model, state, n) {
  const st = (state && state.topics) || {};
  return [...model.topics].sort((a, b) => ((st[a.id] && st[a.id].last) || 0) - ((st[b.id] && st[b.id].last) || 0)).slice(0, n);
}

// Alternates between recent uploads and all-time picks, and cycles through each topic's queries.
export function searchPlan(topic, state, model, nowMs) {
  const runs = (state.topics && state.topics[topic.id] && state.topics[topic.id].runs) || 0;
  const mode = runs % 2 === 0 ? 'fresh' : 'evergreen';
  const q = topic.q[Math.floor(runs / 2) % topic.q.length];
  const s = model.s;
  const params = {
    part: 'snippet',
    type: 'video',
    q,
    maxResults: '25',
    order: 'relevance',
    videoDuration: 'long',
    regionCode: s.region,
    relevanceLanguage: s.language,
    safeSearch: 'moderate',
  };
  if (mode === 'fresh') params.publishedAfter = new Date(nowMs - s.freshDays * 864e5).toISOString();
  return { mode, params };
}

export function departmentsMeta(cfg) {
  return cfg.departments.map((d) => ({
    id: d.id,
    short: d.short,
    name: d.name,
    alloc: d.alloc,
    topics: d.topics.map((t, i) => ({ id: `${d.id}-${i}`, name: t.name })),
  }));
}
