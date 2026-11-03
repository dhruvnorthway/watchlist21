import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDuration, decode, compile, toItem, topicMatches, clickbaitSignals, chapterCount,
  evaluate, merge, pickTopics, searchPlan, departmentsMeta,
} from '../scripts/lib.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config/interests.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-03T00:00:00Z');
const mk = (o = {}) => ({
  id: 'AAAAAAAAAAA', title: 'Clausewitz On War: a full lecture on strategy', desc: 'A lecture on Clausewitz and strategy, doctrine and war.',
  tags: [], channel: 'Some Channel', channelId: 'UCsome', published: '2026-10-20T00:00:00Z', dur: 4800, caption: false,
  live: 'none', privacy: 'public', blocked: null, allowed: null, audioLang: 'en', ...o,
});

test('config has nine departments, 68 topics, allocations sum to 100', () => {
  const m = compile(cfg);
  assert.equal(cfg.departments.length, 9);
  assert.equal(m.topics.length, 68);
  assert.equal(cfg.departments.reduce((a, d) => a + d.alloc, 0), 100);
  assert.equal(departmentsMeta(cfg)[0].topics[0].id, '1-0');
});

test('parseDuration', () => {
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT45M'), 2700);
  assert.equal(parseDuration('PT30S'), 30);
  assert.equal(parseDuration('P1DT1H'), 90000);
  assert.equal(parseDuration('P0D'), 0);
  assert.equal(parseDuration('garbage'), 0);
  assert.equal(parseDuration(undefined), 0);
});

test('decode handles entities', () => {
  assert.equal(decode('Rome&#39;s &amp; Greece&#39;s &quot;rise&quot;'), 'Rome\'s & Greece\'s "rise"');
});

test('chapterCount', () => {
  assert.equal(chapterCount('0:00 Intro\n3:10 Part one\n1:02:15 Part two\n1:30:00 End'), 4);
  assert.equal(chapterCount('no stamps here'), 0);
});

test('a strategy lecture is kept and filed under Strategy', () => {
  const m = compile(cfg);
  const r = evaluate(mk(), m, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.rec.dept, 1);
  assert.ok(r.rec.topics.includes('1-2'));
  assert.ok(r.rec.score > 0.5 && r.rec.score <= 1);
});

test('off-interest video is dropped', () => {
  const m = compile(cfg);
  const r = evaluate(mk({ title: 'Easy pasta carbonara recipe', desc: 'Cook pasta with eggs and cheese.' }), m, NOW);
  assert.deepEqual([r.ok, r.why], [false, 'offtopic']);
});

test('exclusion rules', () => {
  const m = compile(cfg);
  const why = (o) => evaluate(mk(o), m, NOW).why;
  assert.equal(why({ dur: 50 }), 'short');
  assert.equal(why({ dur: 300 }), 'tooshort');
  assert.equal(why({ dur: 60 * 600 }), 'toolong');
  assert.equal(why({ live: 'live' }), 'live');
  assert.equal(why({ privacy: 'private' }), 'notpublic');
  assert.equal(why({ blocked: ['IN'] }), 'region');
  assert.equal(why({ allowed: ['US'] }), 'region');
  assert.equal(why({ audioLang: 'fr' }), 'language');
  assert.equal(why({ title: 'Reacting to Clausewitz On War' }), 'excluded');
  assert.equal(why({ title: 'Sigma mindset strategy for war' }), 'excluded');
  assert.equal(why({ id: 'short' }), 'badid');
  assert.equal(evaluate(mk({ audioLang: 'en-US' }), m, NOW).ok, true);
  assert.equal(evaluate(mk({ audioLang: 'hi' }), m, NOW).ok, true);
  assert.equal(evaluate(mk({ blocked: ['US'] }), m, NOW).ok, true);
});

test('clickbait: two signals drop a video, one only lowers the score', () => {
  const m = compile(cfg);
  assert.equal(clickbaitSignals('A calm lecture on strategy', m), 0);
  const strong = 'SHOCKING!!! You won\'t believe this WAR STRATEGY';
  assert.ok(clickbaitSignals(strong, m) >= 2);
  assert.equal(evaluate(mk({ title: strong }), m, NOW).why, 'clickbait');
  const plain = evaluate(mk({ title: 'Clausewitz On War: strategy lecture' }), m, NOW).rec.score;
  const one = evaluate(mk({ title: 'Clausewitz On War: strategy lecture!!' }), m, NOW).rec.score;
  assert.ok(one < plain);
});

test('trusted channel is flagged and scores higher', () => {
  const m = compile(cfg);
  const base = evaluate(mk(), m, NOW).rec;
  m.trusted.add('UCsome');
  const t = evaluate(mk(), m, NOW).rec;
  assert.equal(base.trusted, false);
  assert.equal(t.trusted, true);
  assert.ok(t.score > base.score);
});

test('structured long lectures outrank thin short ones, and views are never read', () => {
  const m = compile(cfg);
  const chapters = '0:00 Intro\n5:00 One\n20:00 Two\n40:00 Three\n';
  const deep = evaluate(mk({ desc: 'Clausewitz strategy doctrine war. ' + chapters, caption: true }), m, NOW).rec.score;
  const thin = evaluate(mk({ dur: 600 }), m, NOW).rec.score;
  assert.ok(deep > thin);
  const src = readFileSync(new URL('../scripts/lib.mjs', import.meta.url), 'utf8');
  assert.ok(!/viewCount|likeCount|subscriberCount/.test(src));
});

test('topicMatches needs the minimum score', () => {
  const m = compile(cfg);
  assert.equal(topicMatches(mk({ title: 'A walk in the park', desc: 'strategy' }), m).length, 0);
});

test('toItem reads an API resource', () => {
  const it = toItem({
    id: 'BBBBBBBBBBB',
    snippet: { title: 'Rome&#39;s fall', description: 'd', channelTitle: 'C', channelId: 'UC1', publishedAt: '2026-01-01T00:00:00Z', liveBroadcastContent: 'none', tags: ['a'], defaultAudioLanguage: 'en' },
    contentDetails: { duration: 'PT1H', caption: 'true', regionRestriction: { blocked: ['IN'] } },
    status: { privacyStatus: 'public' },
  });
  assert.equal(it.title, "Rome's fall");
  assert.equal(it.dur, 3600);
  assert.equal(it.caption, true);
  assert.deepEqual(it.blocked, ['IN']);
});

test('merge keeps the first added date and caps the list', () => {
  const old = [{ id: 'a', score: 0.5, published: '2026-01-01', added: '2026-02-02T00:00:00Z' }];
  const fresh = [
    { id: 'a', score: 0.6, published: '2026-01-01' },
    { id: 'b', score: 0.9, published: '2026-03-01' },
    { id: 'c', score: 0.1, published: '2026-03-02' },
  ];
  const out = merge(old, fresh, '2026-11-03T00:00:00Z', 2);
  assert.deepEqual(out.map((v) => v.id), ['b', 'a']);
  assert.equal(out[1].added, '2026-02-02T00:00:00Z');
  assert.equal(out[0].added, '2026-11-03T00:00:00Z');
});

test('pickTopics rotates by least recently searched', () => {
  const m = compile(cfg);
  const state = { topics: { '1-0': { last: 5 }, '1-1': { last: 1 } } };
  const picked = pickTopics(m, state, 3).map((t) => t.id);
  assert.ok(!picked.includes('1-0'));
  assert.equal(picked.length, 3);
  assert.deepEqual(pickTopics(m, { topics: {} }, 2).map((t) => t.id), ['1-0', '1-1']);
});

test('searchPlan alternates fresh and evergreen and cycles queries', () => {
  const m = compile(cfg);
  const t = m.topics[0];
  const p0 = searchPlan(t, { topics: {} }, m, NOW);
  const p1 = searchPlan(t, { topics: { [t.id]: { runs: 1 } } }, m, NOW);
  const p2 = searchPlan(t, { topics: { [t.id]: { runs: 2 } } }, m, NOW);
  assert.equal(p0.mode, 'fresh');
  assert.ok(p0.params.publishedAfter);
  assert.equal(p1.mode, 'evergreen');
  assert.equal(p1.params.publishedAfter, undefined);
  assert.equal(p0.params.q, t.q[0]);
  assert.equal(p1.params.q, t.q[0]);
  assert.equal(p2.params.q, t.q[1]);
  assert.equal(p0.params.regionCode, 'IN');
  assert.equal(p0.params.videoDuration, 'any');
});
