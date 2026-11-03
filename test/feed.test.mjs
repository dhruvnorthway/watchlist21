import test from 'node:test';
import assert from 'node:assert/strict';
import { squash, normPrefs, emptyPrefs, affinity, rank, pattern, compose, inDept, fmtDur, signalOf, trimOpened } from '../assets/feed.js';

const meta = {
  departments: [{ id: 1, alloc: 16 }, { id: 2, alloc: 15 }, { id: 9, alloc: 5 }],
  modes: { personal: 50, trusted: 25, unexpected: 25 },
};
let n = 0;
const vid = (o = {}) => ({
  id: 'V' + String(++n).padStart(10, '0'), title: 't', channel: 'Ch', channelId: 'UC1', dept: 1, topics: ['1-0'],
  published: '2026-10-01T00:00:00Z', score: 0.6, trusted: false, dur: 3600, ...o,
});

test('pattern spreads 50/25/25 evenly', () => {
  const p = pattern(meta.modes, 20);
  assert.deepEqual(p.slice(0, 4), ['A', 'B', 'C', 'A']);
  assert.equal(p.filter((x) => x === 'A').length, 10);
  assert.equal(p.filter((x) => x === 'B').length, 5);
  assert.equal(p.filter((x) => x === 'C').length, 5);
  assert.equal(pattern({}, 4).filter((x) => x === 'A').length, 2);
});

test('squash is bounded and gradual', () => {
  assert.equal(squash(0), 0);
  assert.ok(squash(1) < 0.3);
  assert.ok(squash(100) < 1);
  assert.ok(squash(-1) < 0);
});

test('normPrefs rejects junk', () => {
  const p = normPrefs({ liked: { bad: { c: 'x' }, AAAAAAAAAAA: { c: 'UC1', t: ['1-0', 'zzz'] } }, hidden: 5, opened: { AAAAAAAAAAA: 3, no: 1 } });
  assert.deepEqual(Object.keys(p.liked), ['AAAAAAAAAAA']);
  assert.deepEqual(p.liked.AAAAAAAAAAA.t, ['1-0']);
  assert.deepEqual(p.hidden, {});
  assert.deepEqual(Object.keys(p.opened), ['AAAAAAAAAAA']);
  assert.deepEqual(normPrefs(null), emptyPrefs());
});

test('liking raises a channel and its topics, gradually', () => {
  const a = vid({ channelId: 'UCa', topics: ['1-0'], score: 0.6 });
  const b = vid({ channelId: 'UCb', topics: ['1-1'], score: 0.62 });
  const liked = vid({ channelId: 'UCa', topics: ['1-0'] });
  const prefs = emptyPrefs();
  assert.equal(rank([a, b], prefs, meta)[0].v, b);
  prefs.liked[liked.id] = signalOf(liked);
  prefs.liked['W0000000001'] = signalOf(liked);
  const r = rank([a, b], prefs, meta);
  assert.equal(r[0].v, a);
});

test('one hidden video never removes a subject or its channel', () => {
  const a = vid({ channelId: 'UCa', topics: ['1-0'], score: 0.7 });
  const same = vid({ channelId: 'UCa', topics: ['1-0'], score: 0.7 });
  const prefs = emptyPrefs();
  prefs.hidden[same.id] = signalOf(same);
  const r = rank([a, same], prefs, meta);
  assert.equal(r.length, 1);
  assert.equal(r[0].v, a);
  assert.ok(r[0].final > 0.5);
  const aff = affinity(prefs);
  assert.equal(aff.ch.UCa, -1);
  assert.equal(aff.tp['1-0'], -0.5);
});

test('opened videos move to the end', () => {
  const a = vid({ score: 0.9 });
  const b = vid({ score: 0.5 });
  const prefs = emptyPrefs();
  prefs.opened[a.id] = 1;
  const feed = compose(rank([a, b], prefs, meta), meta);
  assert.deepEqual(feed.map((x) => x.v), [b, a]);
  assert.equal(feed[1].opened, true);
});

test('compose follows the 50/25/25 pattern and never repeats a video', () => {
  const vids = [];
  for (let i = 0; i < 40; i++) vids.push(vid({ dept: i % 3 === 0 ? 9 : 1, channelId: 'UC' + i, trusted: i % 4 === 0, score: 0.3 + (i % 10) / 20 }));
  const feed = compose(rank(vids, emptyPrefs(), meta), meta);
  assert.equal(feed.length, 40);
  assert.equal(new Set(feed.map((x) => x.v.id)).size, 40);
  const first20 = feed.slice(0, 20).map((x) => x.mode);
  assert.equal(first20.filter((m) => m === 'A').length, 10);
  assert.equal(first20.filter((m) => m === 'B').length, 5);
  assert.equal(first20.filter((m) => m === 'C').length, 5);
  feed.filter((x) => x.mode === 'B').slice(0, 5).forEach((x) => assert.ok(x.v.trusted));
});

test('unexpected slots favour departments you weight least', () => {
  const big = [];
  for (let i = 0; i < 8; i++) big.push(vid({ dept: 1, channelId: 'UCx' + i, score: 0.8 }));
  const rabbit = vid({ dept: 9, channelId: 'UCr', score: 0.7 });
  const feed = compose(rank(big.concat([rabbit]), emptyPrefs(), meta), meta);
  assert.equal(feed[2].mode, 'C');
  assert.equal(feed[2].v, rabbit);
});

test('when trusted channels are missing the feed still fills', () => {
  const vids = [vid({ channelId: 'UC1' }), vid({ channelId: 'UC2' }), vid({ channelId: 'UC3' }), vid({ channelId: 'UC4' })];
  const feed = compose(rank(vids, emptyPrefs(), meta), meta);
  assert.equal(feed.length, 4);
});

test('inDept filters and keeps opened last', () => {
  const a = vid({ dept: 1, score: 0.9 });
  const b = vid({ dept: 2, score: 0.9 });
  const c = vid({ dept: 1, score: 0.4 });
  const prefs = emptyPrefs();
  prefs.opened[a.id] = 1;
  const list = inDept(rank([a, b, c], prefs, meta), 1);
  assert.deepEqual(list.map((x) => x.v), [c, a]);
});

test('trimOpened drops the oldest', () => {
  const p = emptyPrefs();
  for (let i = 0; i < 5; i++) p.opened['O' + String(i).padStart(10, '0')] = i;
  trimOpened(p, 3);
  assert.deepEqual(Object.keys(p.opened), ['O0000000002', 'O0000000003', 'O0000000004']);
});

test('fmtDur', () => {
  assert.equal(fmtDur(75), '1:15');
  assert.equal(fmtDur(3723), '1:02:03');
  assert.equal(fmtDur(4800), '1:20:00');
});
