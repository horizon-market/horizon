import type { DuplicateWarning, IndexedMarket } from './types.js';

const STOPWORDS = new Set(['will', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'be', 'is', 'are', 'by', 'for',
  'and', 'or', 'this', 'that', 'before', 'after', 'than', 'more', 'less', 'any', 'does', 'do', 'did', 'have', 'has']);

export function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !STOPWORDS.has(word)));
}

/** Jaccard overlap of significant words. A heuristic for review, never an automatic rejection. */
export function similarity(left: string, right: string): number {
  const a = tokens(left), b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Overlap is computed against live indexed markets, so every warning cites a real market. */
export function findDuplicates(question: string, markets: IndexedMarket[], threshold = 0.35): DuplicateWarning[] {
  return markets
    .map(market => ({ market, score: similarity(question, market.question) }))
    .filter(entry => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(entry => ({
      market: entry.market.id,
      question: entry.market.question,
      closeAt: entry.market.closeAt,
      similarity: Math.round(entry.score * 100) / 100,
      reason: entry.score >= 0.6
        ? 'Substantially overlapping wording with an existing indexed market. Trade the existing market instead of paying for a duplicate.'
        : 'Partially overlapping wording with an existing indexed market. Confirm the resolution criteria differ before paying.',
    }));
}
