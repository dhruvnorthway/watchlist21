// Finds new videos that match config/interests.json and writes data/videos.json.
// Run by the GitHub workflow. Needs the YT_API_KEY environment variable.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { compile, toItem, evaluate, merge, pickTopics, searchPlan, departmentsMeta } from './lib.mjs';
import { assessBatch, heuristicQuality } from './quality.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://www.googleapis.com/youtube/v3/';

class QuotaError extends Error {}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${file}: ${e.message}`);
  }
}

// One line per video keeps the daily change in git readable.
export function serialize(out) {
  const { videos, ...rest } = out;
  return JSON.stringify(rest).slice(0, -1) + ',"videos":[\n' + videos.map((v) => JSON.stringify(v)).join(',\n') + '\n]}\n';
}

export async function init({ root = ROOT } = {}) {
  const cfg = JSON.parse(await readFile(path.join(root, 'config/interests.json'), 'utf8'));
  await mkdir(path.join(root, 'data'), { recursive: true });
  const out = { updated: null, departments: departmentsMeta(cfg), modes: cfg.settings.modes, videos: [] };
  await writeFile(path.join(root, 'data/videos.json'), serialize(out));
  await writeFile(path.join(root, 'data/state.json'), JSON.stringify({ topics: {}, channels: {} }, null, 1) + '\n');
}

export async function run({
  root = ROOT,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  log = console.log,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const key = env.YT_API_KEY;
  if (!key) {
    throw new Error('YT_API_KEY is not set. Add your YouTube API key as a repository secret named YT_API_KEY (see README).');
  }
  const cfg = JSON.parse(await readFile(path.join(root, 'config/interests.json'), 'utf8'));
  const model = compile(cfg);
  const s = model.s;
  const dataPath = path.join(root, 'data/videos.json');
  const statePath = path.join(root, 'data/state.json');
  const lib = await readJson(dataPath, { videos: [] });
  const state = await readJson(statePath, { topics: {}, channels: {} });
  state.topics = state.topics || {};
  state.channels = state.channels || {};
  const existing = Array.isArray(lib.videos) ? lib.videos : [];
  const existingMap = new Map(existing.map((v) => [v.id, v]));
  const nowIso = new Date(now).toISOString();
  let units = 0;
  let quotaHit = false;

  async function api(endpoint, params, cost) {
    const url = new URL(API + endpoint);
    for (const [k, v] of Object.entries({ ...params, key })) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url);
      if (res.ok) {
        units += cost;
        return res.json();
      }
      const body = await res.json().catch(() => ({}));
      const reason = (body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason) || '';
      if (res.status === 403 && /quota|ratelimit|dailylimit/i.test(reason)) throw new QuotaError(reason);
      if (res.status >= 500 && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const msg = (body.error && body.error.message) || '';
      throw new Error(`YouTube API ${endpoint} failed (${res.status} ${reason}). ${msg}`.trim());
    }
  }

  // 1. Trusted channels: find their ids, then read their newest uploads.
  const uploadIds = [];
  const channelIds = [];
  for (const c of cfg.trustedChannels || []) {
    let id = c.id || '';
    if (!id && c.handle) {
      id = state.channels[c.handle] || '';
      if (!id) {
        try {
          const r = await api('channels', { part: 'id', forHandle: c.handle }, 1);
          id = (r.items && r.items[0] && r.items[0].id) || '';
          if (id) state.channels[c.handle] = id;
          else log(`Could not find a channel for ${c.handle}. Check the handle in config/interests.json.`);
        } catch (e) {
          if (e instanceof QuotaError) { quotaHit = true; break; }
          throw e;
        }
      }
    }
    if (id) {
      model.trusted.add(id);
      channelIds.push(id);
    }
  }
  for (const id of channelIds) {
    if (quotaHit || !id.startsWith('UC')) continue;
    try {
      const r = await api('playlistItems', { part: 'contentDetails', playlistId: 'UU' + id.slice(2), maxResults: String(s.uploadsPerTrustedChannel) }, 1);
      for (const it of r.items || []) if (it.contentDetails && it.contentDetails.videoId) uploadIds.push(it.contentDetails.videoId);
    } catch (e) {
      if (e instanceof QuotaError) { quotaHit = true; break; }
      log(`Could not read uploads for channel ${id}: ${e.message}`);
    }
  }

  // 2. Search the topics that have waited longest.
  const found = new Set();
  let searched = 0;
  if (!quotaHit) {
    for (const t of pickTopics(model, state, s.searchesPerRun)) {
      if (units + 100 > s.unitBudgetPerRun) break;
      const { params } = searchPlan(t, state, model, now);
      let r;
      try {
        r = await api('search', params, 100);
      } catch (e) {
        if (e instanceof QuotaError) { quotaHit = true; break; }
        throw e;
      }
      for (const it of r.items || []) if (it.id && it.id.videoId) found.add(it.id.videoId);
      const st = state.topics[t.id] || (state.topics[t.id] = { runs: 0, last: 0 });
      st.runs += 1;
      st.last = now;
      searched += 1;
    }
  }

  // 3. Fetch full details for new finds and re-check everything already saved.
  const ids = [...new Set([...existing.map((v) => v.id), ...uploadIds, ...found])];
  const returned = new Map();
  const answered = new Set();
  for (let i = 0; i < ids.length && !quotaHit; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      // No maxResults here: YouTube rejects it when videos are requested by id.
      const r = await api('videos', { part: 'snippet,contentDetails,status', id: batch.join(',') }, 1);
      batch.forEach((id) => answered.add(id));
      for (const v of r.items || []) returned.set(v.id, v);
    } catch (e) {
      if (e instanceof QuotaError) { quotaHit = true; break; }
      throw e;
    }
  }

  // 4. Assess promising new candidates using the free deterministic quality model.
  const candidateItems = [...found, ...uploadIds].filter((id) => returned.has(id)).map((id) => toItem(returned.get(id)));
  const qualityById = await assessBatch(candidateItems, model, { log });
  for (const id of existingMap.keys()) {
    const old = existingMap.get(id);
    if (old.quality != null) qualityById.set(id, { score: old.quality, dimensions: old.qualityDimensions || {}, confidence: old.qualityConfidence || 'low', basis: old.qualityBasis || 'legacy', reason: old.qualityReason || '' });
  }

  // 5. Judge each video. A saved video that YouTube no longer returns has been removed or made private.
  const kept = [];
  const carried = [];
  const dropped = {};
  let gone = 0;
  for (const id of ids) {
    if (returned.has(id)) {
      const item = toItem(returned.get(id));
      const quality = qualityById.get(id) || heuristicQuality(item, model);
      const res = evaluate(item, model, now, quality);
      if (res.ok) kept.push(res.rec);
      else dropped[res.why] = (dropped[res.why] || 0) + 1;
    } else if (!answered.has(id)) {
      if (existingMap.has(id)) carried.push(existingMap.get(id));
    } else if (existingMap.has(id)) {
      gone += 1;
    }
  }
  const videos = merge(existing, kept.concat(carried), nowIso, s.maxVideos);
  const added = videos.filter((v) => !existingMap.has(v.id)).length;

  await mkdir(path.join(root, 'data'), { recursive: true });
  state.lastRun = nowIso;
  state.lastUnits = units;
  await writeFile(dataPath, serialize({ updated: nowIso, departments: departmentsMeta(cfg), modes: s.modes, videos }));
  await writeFile(statePath, JSON.stringify(state, null, 1) + '\n');

  const summary = { searched, units, candidates: ids.length, added, total: videos.length, gone, dropped, quotaHit };
  log(`Searched ${searched} topics using about ${units} quota units${quotaHit ? ' (daily quota reached, stopped early)' : ''}.`);
  log(`Checked ${ids.length} videos: ${added} new, ${videos.length} in the library, ${gone} removed by YouTube.`);
  log('Quality assessment: free deterministic metadata signals; no paid AI API required.');
  log('Dropped: ' + (Object.keys(dropped).length ? Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', ') : 'none'));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const job = process.argv.includes('--init') ? init() : run();
  job.catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
