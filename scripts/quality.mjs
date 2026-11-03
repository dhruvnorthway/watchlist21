// Quality assessment: deterministic baseline plus an optional batched AI evaluator.
// The AI sees public metadata only. It must not claim to have watched a video or verified credentials.
import { topicMatches, chapterCount, norm } from './lib.mjs';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

export function heuristicQuality(item, model) {
  const matches = topicMatches(item, model);
  const title = norm(item.title);
  const desc = String(item.desc || '');
  const chapters = chapterCount(desc);
  const words = desc.trim().split(/\s+/).filter(Boolean).length;
  const duration = item.dur / 60;
  const formatTerms = /\b(lecture|documentary|explained|deep dive|analysis|interview|case study|masterclass|course|seminar|investigation|how it works|history of)\b/i;
  const lowEffort = /\b(reaction|prank|challenge|compilation|meme|shorts?)\b/i.test(title);
  const titleSpecificity = title.split(/\s+/).filter((w) => w.length > 3).length;
  const substance = clamp(30 + Math.min(25, words / 18) + Math.min(20, chapters * 4) + (formatTerms.test(title) ? 12 : 0) + (duration >= 20 ? 8 : 0) - (lowEffort ? 35 : 0));
  const explanation = clamp(25 + Math.min(25, chapters * 5) + (formatTerms.test(title) ? 18 : 0) + (desc.length > 700 ? 12 : 0) + (item.caption ? 8 : 0));
  const relevance = clamp(matches.length ? 45 + matches[0].score * 8 : 0);
  const evidence = clamp(20 + (chapters >= 3 ? 15 : 0) + (words > 120 ? 15 : 0) + (item.caption ? 10 : 0));
  const originality = clamp(35 + (titleSpecificity >= 6 ? 12 : 0) + (chapters >= 4 ? 8 : 0) + (duration >= 25 ? 5 : 0));
  // Metadata cannot establish credentials. Keep expertise deliberately conservative.
  const expertise = clamp(35 + (item.channelId ? 5 : 0) + (/\b(university|institute|research|professor|engineer|official)\b/i.test(item.channel) ? 12 : 0));
  const score = clamp(substance * .25 + expertise * .20 + originality * .20 + explanation * .15 + evidence * .10 + relevance * .10);
  return {
    score,
    dimensions: { substance, expertise, originality, explanation, evidence, relevance },
    confidence: 'low',
    basis: 'metadata',
    reason: 'Baseline estimate from title, description structure, duration and topic signals. Not a transcript-level judgement.',
  };
}

function compactCandidate(item, model) {
  const matches = topicMatches(item, model);
  return {
    id: item.id,
    title: item.title,
    channel: item.channel,
    description: String(item.desc || '').slice(0, 1800),
    durationMinutes: Math.round(item.dur / 60),
    hasCaptions: !!item.caption,
    chapters: chapterCount(item.desc),
    matchedTopics: matches.map((m) => model.topics.find((t) => t.id === m.id)?.name).filter(Boolean),
  };
}

// Fully free, deterministic quality assessment. No paid AI API or extra key required.
// Metadata signals are proxies, not a substitute for reviewing the video itself.
export async function assessBatch(items, model, { log = () => {} } = {}) {
  const results = new Map(items.map((item) => [item.id, heuristicQuality(item, model)]));
  log(`Applied deterministic quality assessment to ${results.size} candidates (no paid AI services).`);
  return results;
}
