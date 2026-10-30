// Markdown application tracker. The table layout is the same as career-ops'
// data/applications.md, so either tool can read the other's file:
// | # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { localDate } from './config.mjs';

export const HEADER = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |';
const RULE = '|---|------|---------|------|-------|--------|-----|--------|-------|-----|';

// Canonical states, in lifecycle order. Terminal states supersede earlier ones.
export const STATES = [
  { id: 'Evaluated', aliases: ['evaluated', 'consider', 'hold'], rank: 0 },
  { id: 'SKIP', aliases: ['skip', 'skipped'], rank: 0 },
  { id: 'Discarded', aliases: ['discarded', 'closed', 'duplicate'], rank: 0.5 },
  { id: 'Applied', aliases: ['applied', 'sent', 'submitted'], rank: 1 },
  { id: 'Responded', aliases: ['responded', 'replied'], rank: 2 },
  { id: 'Interview', aliases: ['interview'], rank: 3 },
  { id: 'Offer', aliases: ['offer'], rank: 4, terminal: true },
  { id: 'Rejected', aliases: ['rejected'], rank: 4, terminal: true },
];

export function canonicalStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  const hit = STATES.find((s) => s.id.toLowerCase() === v || s.aliases.includes(v));
  return hit ? hit.id : null;
}

const DATE_RE = /20\d\d-\d\d-\d\d/g;
const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim();

export function parseScore(raw) {
  const m = String(raw || '').match(/([\d.]+)\s*(\/\s*(100|5))?/);
  if (!m) return null;
  const v = Number(m[1]);
  return m[3] === '100' || v > 5 ? Math.round(v) : Math.round(v * 20);
}

function parseLine(line) {
  const c = line.split('|').map((x) => x.trim());
  return {
    num: Number(c[1]), date: c[2], company: c[3], role: c[4], score: c[5], status: c[6],
    pdf: c[7], report: c[8], notes: c[9] || '', url: c[10] || '',
  };
}

const formatLine = (r) => `| ${r.num} | ${cell(r.date)} | ${cell(r.company)} | ${cell(r.role)} | ${cell(r.score || '-')} | ${cell(r.status)} | ${cell(r.pdf || '-')} | ${cell(r.report || '-')} | ${cell(r.notes)} | ${cell(r.url || '-')} |`;

export class Tracker {
  constructor(file) {
    this.file = file;
    this.lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : ['# Applications Tracker', '', HEADER, RULE];
  }

  rows() {
    return this.lines.filter((l) => /^\| *\d+ \|/.test(l)).map(parseLine);
  }

  get(num) {
    return this.rows().find((r) => r.num === Number(num)) || null;
  }

  nextNumber() {
    return this.rows().reduce((m, r) => Math.max(m, r.num), 0) + 1;
  }

  add(row) {
    const status = canonicalStatus(row.status) || 'Evaluated';
    const full = { date: localDate(), score: '-', ...row, status, num: this.nextNumber() };
    while (this.lines.length && this.lines.at(-1) === '') this.lines.pop();
    this.lines.push(formatLine(full));
    return full;
  }

  /** Set status and append a dated note. Notes without a leading date get today's. */
  setStatus(num, status, note) {
    const canon = canonicalStatus(status);
    if (!canon) throw new Error(`unknown status "${status}" (use one of ${STATES.map((s) => s.id).join(', ')})`);
    const i = this.lines.findIndex((l) => new RegExp(`^\\| *${Number(num)} \\|`).test(l));
    if (i < 0) throw new Error(`row #${num} not found`);
    const row = parseLine(this.lines[i]);
    const before = row.status;
    row.status = canon;
    if (note) {
      const dated = /^20\d\d-\d\d-\d\d/.test(note.trim()) ? note.trim() : `${localDate()}: ${note.trim()}`;
      row.notes = row.notes ? `${row.notes}; ${dated}` : dated;
    }
    this.lines[i] = formatLine(row);
    return { before, after: canon, row };
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${this.lines.join('\n').replace(/\n*$/, '')}\n`, 'utf8');
    renameSync(tmp, this.file);
  }
}

// ---- derived views -------------------------------------------------------

export function normalizeUrl(raw) {
  const value = String(raw || '').match(/https?:\/\/[^\s|;)]+/i)?.[0] || '';
  if (!value) return '';
  try {
    const url = new URL(value);
    const li = url.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{8,})/);
    if (/linkedin\.com$/i.test(url.hostname) && li) return `linkedin#${li[1]}`;
    const jk = /indeed\./i.test(url.hostname) ? url.searchParams.get('jk') : null;
    if (jk) return `indeed#${jk}`;
    // Preserve job IDs and SPA routes; remove only known tracking parameters.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.*|ref|refid|trk|trackingid|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '');
  } catch { return value.toLowerCase(); }
}

const norm = (v) => String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const STOP = new Set(['stage', 'stagiaire', 'intern', 'internship', 'm2', 'mois', 'months', 'month', 'de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'and', 'the', 'of', 'for', 'pour', 'h', 'f', 'x']);
const tokens = (v) => new Set(norm(v).split(' ').filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t)));

export function similarity(a, b) {
  const l = tokens(a), r = tokens(b);
  if (!l.size || !r.size) return 0;
  let i = 0;
  for (const t of l) if (r.has(t)) i += 1;
  return Math.max(i / (l.size + r.size - i), (i / Math.min(l.size, r.size)) * 0.9);
}

const sameCompany = (a, b) => {
  if (norm(a) && norm(a) === norm(b)) return true;
  // Do not use a partial Chinese company name to merge unrelated employers.
  if (/\p{Script=Han}/u.test(`${a || ''}${b || ''}`)) return false;
  const x = norm(a).split(' ')[0], y = norm(b).split(' ')[0];
  return x.length >= 3 && y.length >= 3 && (norm(a).includes(y) || norm(b).includes(x));
};

/** Existing rows that look like the same posting (URL first, then company + role). */
export function findDuplicates(rows, candidate, threshold = 0.7) {
  const key = normalizeUrl(candidate.url);
  return rows.filter((r) => {
    if (key && normalizeUrl(r.url || r.notes) === key) return true;
    // Distinct links on the same recruitment host represent separate requisitions.
    try {
      const a = new URL(r.url), b = new URL(candidate.url);
      if (a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '') && normalizeUrl(r.url) !== key) return false;
    } catch { /* Missing URLs: fall back to the employer and title. */ }
    return sameCompany(r.company, candidate.company) && similarity(r.role, candidate.role) >= threshold;
  });
}

/** Rough event type from a note fragment; order matters. */
export function eventKind(text) {
  if (/reject|not retained|non retenue|not selected|regret|already filled|has been filled|unable to offer|not .{0,20}moving forward|拒|未录用/i.test(text)) return 'rejected';
  if (/\binterview|entretien|面试|\bvisio\b/i.test(text)) return 'interview';
  if (/follow-?up|relancer|\breminder|check-in|跟进/i.test(text)) return 'followup';
  if (/\b(replied|replies)\b|\basked\b|\bresponded\b|回信|回复了|收到.{0,40}回复/i.test(text)) return 'reply';
  if (/submit|applied|\bsent\b|scheduled|emailed|投递|发送|已发/i.test(text)) return 'sent';
  return 'note';
}

/** Dated fragments of the notes cell, ignoring future dates such as start dates. */
export function events(row, today = localDate()) {
  const out = [];
  // An event starts at a date at the beginning of the cell or after "; ", "。" or ". ";
  // dates inside a sentence ("scheduled for 2026-10-30") stay part of the text.
  const re = /(?:^|[;。]\s*|\.\s+)(20\d\d-\d\d-\d\d)(?:[ T]\d\d:\d\d)?[:\s]+([^]*?)(?=(?:[;。]\s*|\.\s+)20\d\d-\d\d-\d\d|$)/g;
  for (const m of String(row.notes || '').matchAll(re)) {
    if (m[1] > today) continue;
    const text = m[2].trim().replace(/^[:;,\s]+/, '').slice(0, 240);
    if (text) out.push({ date: m[1], kind: eventKind(text), text });
  }
  return out;
}

export function lastActivity(row, today = localDate()) {
  const dates = [row.date, ...(String(row.notes || '').match(DATE_RE) || [])].filter((d) => d && d <= today).sort();
  return dates.at(-1) || row.date;
}
