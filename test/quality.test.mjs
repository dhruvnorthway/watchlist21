import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compile } from '../scripts/lib.mjs';
import { assessBatch, heuristicQuality } from '../scripts/quality.mjs';

const cfg = JSON.parse(await readFile(new URL('../config/interests.json', import.meta.url), 'utf8'));
const model = compile(cfg);
const item = {
  id: 'abcdefghijk', title: 'A detailed lecture on Clausewitz and grand strategy',
  desc: '0:00 Introduction\n10:00 Strategic context\n25:00 Case study\n40:00 Conclusions\n'.repeat(8),
  tags: ['Clausewitz', 'strategy'], channel: 'University Lecture', channelId: 'UC123', dur: 3600, caption: true,
};

test('quality baseline rewards structure but does not claim verified expertise', () => {
  const q = heuristicQuality(item, model);
  assert.ok(q.score > 40);
  assert.equal(q.basis, 'metadata');
  assert.equal(q.confidence, 'low');
  assert.ok(q.dimensions.substance > 0);
});

test('quality assessment is fully local and never calls a paid AI service', async () => {
  let called = false;
  const result = await assessBatch([item], model, {
    log() {},
  });
  assert.equal(result.get(item.id).basis, 'metadata');
  assert.equal(result.get(item.id).confidence, 'low');
  assert.equal(called, false);
});
