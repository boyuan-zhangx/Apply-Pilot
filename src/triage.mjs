// Turn raw scan output into a short candidate list: keep offers, drop
// job-seeker posts and excluded companies, and mark postings already tracked.
import { hardFilter } from './scoring.mjs';
import { findDuplicates } from './tracker.mjs';
import { checkJobPolicy } from './job-policy.mjs';

const SEEKER_RE = /\b(je recherche|i am looking for|i'm looking for|looking for an? (internship|stage)|open to work|à la recherche d'un stage|seeking an? internship)\b/i;
const OFFER_RE = /\b(offre|stage|internship|intern|stagiaire|master thesis|masterarbeit|praktikum|we are (looking|recruiting|hiring)|nous recrutons|recrute|position|opening)\b/i;

export function triage(scan, rows, profile) {
  const out = [];
  const seen = new Set();
  const push = (kind, query, item) => {
    const key = item.url || item.text.slice(0, 160);
    if (seen.has(key)) return;
    seen.add(key);
    if (kind === 'post' && (SEEKER_RE.test(item.text) || !OFFER_RE.test(item.text))) return;
    const firstLines = item.text.split(/ · | \| /);
    const candidate = { kind, query, url: item.url, company: firstLines[1] || '', role: firstLines[0] || '', text: item.text, people: item.people };
    const filtered = hardFilter(profile, { company: candidate.company, text: candidate.role });
    const dupes = findDuplicates(rows, candidate).map((r) => r.num);
    out.push({ ...candidate, filtered, tracked: dupes });
  };
  for (const s of scan.jobs || []) {
    // Portal scans list jobs directly; LinkedIn scans group cards under queries.
    if (!s.items) {
      const key = s.url;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = { kind: 'portal', query: s.provider, url: s.url, company: s.company, role: s.title, jobType: s.jobType || s.employmentType, text: `${s.title} ${s.location || ''}`, location: s.location, posted: s.posted };
      out.push({ ...candidate, filtered: hardFilter(profile, { company: s.company, text: s.title }), tracked: findDuplicates(rows, candidate).map((r) => r.num) });
      continue;
    }
    for (const it of s.items) push('job', s.query, it);
  }
  for (const s of scan.posts || []) for (const it of s.items) push('post', s.query, it);
  for (const candidate of out) {
    candidate.policy = checkJobPolicy(profile, candidate);
    candidate.needsReview = candidate.policy.status === 'review';
    if (candidate.policy.status === 'excluded') candidate.filtered.push(...candidate.policy.reasons);
  }
  return {
    fresh: out.filter((c) => !c.filtered.length && !c.tracked.length),
    tracked: out.filter((c) => c.tracked.length),
    filtered: out.filter((c) => c.filtered.length && !c.tracked.length),
  };
}
