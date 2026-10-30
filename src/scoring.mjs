// Weighted scoring. The model (or you) rates each dimension 0-5; the weights
// and thresholds live in profile.scoring so the rubric is yours, not the tool's.
//
// profile.scoring = {
//   dimensions: [{ id: "fit", label: "Core skill fit", weight: 25, guide: "..." }, ...],
//   thresholds: { apply: 80, consider: 65 }
// }

export function scoreEvaluation(profile, ratings) {
  const dims = profile.scoring.dimensions;
  if (!dims.length) throw new Error('profile.scoring.dimensions is empty');
  let total = 0, weights = 0;
  const parts = [];
  for (const d of dims) {
    const raw = ratings[d.id];
    const value = typeof raw === 'object' && raw !== null ? raw.score : raw;
    if (value === undefined || value === null || Number.isNaN(Number(value))) throw new Error(`missing rating for "${d.id}"`);
    const v = Math.max(0, Math.min(5, Number(value)));
    total += (v / 5) * d.weight;
    weights += d.weight;
    parts.push({ id: d.id, label: d.label, weight: d.weight, rating: v, reason: raw?.reason || '' });
  }
  const score100 = Math.round((total / weights) * 100);
  const { apply, consider } = profile.scoring.thresholds;
  const decision = score100 >= apply ? 'Apply' : score100 >= consider ? 'Consider' : 'Skip';
  return { score100, score5: Math.round(score100 / 2) / 10, decision, parts };
}

// Whole-word, accent-insensitive match: "CEA" must not hit "Ceapro".
import { containsTerm as hasWord } from './text.mjs';

/**
 * Hard filters run before any scoring: excluded companies and keywords, required keywords.
 * Pass the posting title (not the full description) as `text`: descriptions mention
 * excluded words in passing ("stage ou alternance").
 */
export function hardFilter(profile, { company = '', text = '' }) {
  const f = profile.filters;
  const hay = `${company}\n${text}`;
  const hits = [];
  for (const c of f.excludeCompanies) if (hasWord(company, c)) hits.push(`excluded company: ${c}`);
  for (const k of f.excludeKeywords) if (hasWord(hay, k)) hits.push(`excluded keyword: ${k}`);
  if (f.requireKeywords.length && !f.requireKeywords.some((k) => hasWord(hay, k))) hits.push('none of the required keywords');
  return hits;
}
