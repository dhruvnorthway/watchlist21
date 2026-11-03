import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, init } from '../scripts/update.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-03T00:00:00Z');

async function sandbox() {
  const root = await mkdtemp(path.join(tmpdir(), 'wl-'));
  await cp(path.join(HERE, '../config'), path.join(root, 'config'), { recursive: true });
  await init({ root });
  return root;
}
const vid = (id, o = {}) => ({
  id,
  snippet: { title: 'Clausewitz On War: a full lecture on strategy', description: 'Lecture on Clausewitz, strategy, doctrine and war.', channelTitle: 'Ch', channelId: 'UCabc', publishedAt: '2026-10-20T00:00:00Z', liveBroadcastContent: 'none', defaultAudioLanguage: 'en', ...(o.snippet || {}) },
  contentDetails: { duration: 'PT1H20M', caption: 'true', ...(o.contentDetails || {}) },
  status: { privacyStatus: 'public' },
});
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// A fake YouTube API. `videosById` is what videos.list knows about.
function fakeApi({ searchIds = [], videosById = {}, searchError = null, videoError = null } = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = new URL(String(url));
    const ep = u.pathname.split('/').pop();
    calls.push({ ep, q: u.searchParams.get('q'), id: u.searchParams.get('id'), maxResults: u.searchParams.get('maxResults') });
    if (ep === 'search') {
      if (searchError) return json({ error: { errors: [{ reason: searchError }] } }, 403);
      return json({ items: searchIds.map((id) => ({ id: { videoId: id } })) });
    }
    if (ep === 'videos') {
      if (videoError) return json({ error: { errors: [{ reason: videoError }] } }, 403);
      const ids = u.searchParams.get('id').split(',');
      return json({ items: ids.map((i) => videosById[i]).filter(Boolean) });
    }
    return json({ items: [] });
  };
  return { impl, calls };
}

test('refuses to run without an API key and says what to do', async () => {
  const root = await sandbox();
  await assert.rejects(() => run({ root, env: {}, now: NOW, log() {} }), /YT_API_KEY/);
});

test('end to end: keeps matching videos, drops the rest, writes the file', async () => {
  const root = await sandbox();
  const api = fakeApi({
    searchIds: ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'],
    videosById: {
      AAAAAAAAAAA: vid('AAAAAAAAAAA'),
      BBBBBBBBBBB: vid('BBBBBBBBBBB', { snippet: { title: 'Easy pasta recipe', description: 'cooking pasta' } }),
      CCCCCCCCCCC: vid('CCCCCCCCCCC', { contentDetails: { duration: 'PT45S' } }),
    },
  });
  const sum = await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: api.impl, now: NOW, log() {} });
  assert.equal(sum.searched, 35);
  assert.equal(sum.units, 35 * 100 + 1);
  assert.equal(sum.total, 1);
  assert.deepEqual(sum.dropped, { offtopic: 1, short: 1 });
  const out = JSON.parse(await readFile(path.join(root, 'data/videos.json'), 'utf8'));
  assert.equal(out.updated, '2026-11-03T00:00:00.000Z');
  assert.equal(out.departments.length, 9);
  assert.equal(out.videos.length, 1);
  assert.equal(out.videos[0].id, 'AAAAAAAAAAA');
  assert.equal(out.videos[0].dept, 1);
  assert.equal(out.videos[0].added, '2026-11-03T00:00:00.000Z');
  assert.ok(!('desc' in out.videos[0]));
  const state = JSON.parse(await readFile(path.join(root, 'data/state.json'), 'utf8'));
  assert.equal(Object.keys(state.topics).length, 35);
  assert.equal(state.topics['1-0'].runs, 1);
  assert.equal(api.calls.filter((c) => c.ep === 'search').length, 35);
  // YouTube rejects maxResults on videos.list when ids are given.
  const vcalls = api.calls.filter((c) => c.ep === 'videos');
  assert.ok(vcalls.length >= 1 && vcalls.every((c) => c.maxResults === null));
});

test('second run searches different topics and re-checks saved videos', async () => {
  const root = await sandbox();
  const v = { AAAAAAAAAAA: vid('AAAAAAAAAAA') };
  await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: fakeApi({ searchIds: ['AAAAAAAAAAA'], videosById: v }).impl, now: NOW, log() {} });
  const api2 = fakeApi({ searchIds: [], videosById: v });
  const later = NOW + 12 * 3600e3;
  const sum = await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: api2.impl, now: later, log() {} });
  const state = JSON.parse(await readFile(path.join(root, 'data/state.json'), 'utf8'));
  // 35 topics per run: the first run took topics 0 to 34, the second takes the 33 never searched, then the 2 oldest.
  assert.equal(Object.keys(state.topics).length, 68);
  assert.equal(state.topics['9-7'].runs, 1);
  assert.equal(state.topics['1-0'].runs, 2);
  assert.equal(state.topics['1-2'].runs, 1);
  assert.equal(sum.total, 1);
  const out = JSON.parse(await readFile(path.join(root, 'data/videos.json'), 'utf8'));
  assert.equal(out.videos[0].added, '2026-11-03T00:00:00.000Z');
  assert.ok(api2.calls.some((c) => c.ep === 'videos' && c.id === 'AAAAAAAAAAA'));
});

test('a saved video that YouTube no longer returns is removed', async () => {
  const root = await sandbox();
  const v = { AAAAAAAAAAA: vid('AAAAAAAAAAA') };
  await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: fakeApi({ searchIds: ['AAAAAAAAAAA'], videosById: v }).impl, now: NOW, log() {} });
  const sum = await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: fakeApi({ videosById: {} }).impl, now: NOW + 1, log() {} });
  assert.equal(sum.gone, 1);
  assert.equal(sum.total, 0);
});

test('quota exhausted during search stops early and keeps the saved library', async () => {
  const root = await sandbox();
  const v = { AAAAAAAAAAA: vid('AAAAAAAAAAA') };
  await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: fakeApi({ searchIds: ['AAAAAAAAAAA'], videosById: v }).impl, now: NOW, log() {} });
  const sum = await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: fakeApi({ searchError: 'quotaExceeded', videosById: v }).impl, now: NOW + 5, log() {} });
  assert.equal(sum.quotaHit, true);
  assert.equal(sum.total, 1);
});

test('quota exhausted while re-checking keeps saved videos instead of deleting them', async () => {
  const root = await sandbox();
  const v = { AAAAAAAAAAA: vid('AAAAAAAAAAA') };
  await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: fakeApi({ searchIds: ['AAAAAAAAAAA'], videosById: v }).impl, now: NOW, log() {} });
  const sum = await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: fakeApi({ videoError: 'quotaExceeded', videosById: v }).impl, now: NOW + 5, log() {} });
  assert.equal(sum.quotaHit, true);
  assert.equal(sum.gone, 0);
  assert.equal(sum.total, 1);
});

test('a rejected API key fails loudly with the reason', async () => {
  const root = await sandbox();
  const bad = async () => json({ error: { message: 'API key not valid.', errors: [{ reason: 'badRequest' }] } }, 400);
  await assert.rejects(() => run({ root, env: { YT_API_KEY: 'x' }, fetchImpl: bad, now: NOW, log() {} }), /API key not valid/);
});

test('trusted channels are resolved from a handle and their uploads read', async () => {
  const root = await sandbox();
  const cfgPath = path.join(root, 'config/interests.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  cfg.trustedChannels = [{ name: 'Someone', handle: '@someone' }];
  cfg.settings.searchesPerRun = 0;
  await writeFile(cfgPath, JSON.stringify(cfg));
  const calls = [];
  const impl = async (url) => {
    const u = new URL(String(url));
    const ep = u.pathname.split('/').pop();
    calls.push(ep);
    if (ep === 'channels') return json({ items: [{ id: 'UCtrusted1' }] });
    if (ep === 'playlistItems') {
      assert.equal(u.searchParams.get('playlistId'), 'UUtrusted1');
      return json({ items: [{ contentDetails: { videoId: 'AAAAAAAAAAA' } }] });
    }
    if (ep === 'videos') return json({ items: [vid('AAAAAAAAAAA', { snippet: { channelId: 'UCtrusted1' } })] });
    return json({ items: [] });
  };
  const sum = await run({ root, env: { YT_API_KEY: 'k' }, fetchImpl: impl, now: NOW, log() {} });
  assert.deepEqual(calls, ['channels', 'playlistItems', 'videos']);
  const out = JSON.parse(await readFile(path.join(root, 'data/videos.json'), 'utf8'));
  assert.equal(sum.total, 1);
  assert.equal(out.videos[0].trusted, true);
  const state = JSON.parse(await readFile(path.join(root, 'data/state.json'), 'utf8'));
  assert.equal(state.channels['@someone'], 'UCtrusted1');
});
