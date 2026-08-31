/**
 * Emulated retrieval: keyword matching over a fixed set of articles.
 *
 * This is the emulation most easily mistaken for the real thing. It has the
 * shape of RAG &mdash; a query goes in, ranked documents come out, the agent
 * grounds its answer in them &mdash; and none of the substance: it lowercases
 * the query, splits on non-word characters, and counts tag hits.
 *
 * It cannot do synonyms, paraphrase, or any of the work a vector search
 * actually does. "How long do I have to send something back?" retrieves
 * nothing, because it shares no literal token with the returns article.
 *
 * Deterministic on purpose: the evals in `packages/eval` assert on exact tool
 * results, which a real embedding model could not guarantee.
 */

import type { KnowledgeArticle, KnowledgeProvider } from '../ports.ts';

export const FIXTURE_ARTICLES: KnowledgeArticle[] = [
  {
    id: 'kb-returns',
    title: 'Return policy',
    body: 'Unopened items may be returned within 30 days for a full refund. Opened items incur a 15% restocking fee.',
    tags: ['return', 'refund', 'policy'],
  },
  {
    id: 'kb-shipping',
    title: 'Shipping times',
    body: 'Standard shipping is 3-5 business days. Express is next business day when ordered before 2pm.',
    tags: ['shipping', 'delivery', 'time'],
  },
  {
    id: 'kb-warranty',
    title: 'Warranty coverage',
    body: 'Hardware carries a 2 year limited warranty covering manufacturing defects, not accidental damage.',
    tags: ['warranty', 'repair', 'defect'],
  },
];

export function keywordKnowledge(
  articles: KnowledgeArticle[] = FIXTURE_ARTICLES,
): KnowledgeProvider {
  return {
    mode: 'keyword',
    search(query, limit) {
      const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
      const ranked = articles
        .map((article) => ({
          article,
          score: terms.filter(
            (term) =>
              article.tags.some((tag) => tag.includes(term)) ||
              article.title.toLowerCase().includes(term),
          ).length,
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ article }) => article);

      return Promise.resolve(ranked);
    },
    close: () => Promise.resolve(),
  };
}
