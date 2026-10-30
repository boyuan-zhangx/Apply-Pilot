import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { containsTerm } from './text.mjs';
import { checkJobPolicy } from './job-policy.mjs';
import { hardFilter } from './scoring.mjs';

export const TRACKS = ['robotics', 'autonomous_driving', 'mathematics', 'machine_learning', 'product', 'software'];
const manifest = (home) => join(home, 'resumes', 'index.json');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export function readResumeLibrary(home) {
  if (!existsSync(manifest(home))) return [];
  const data = JSON.parse(readFileSync(manifest(home), 'utf8'));
  if (!Array.isArray(data)) throw new Error('resumes/index.json must be an array');
  return data;
}

/** Each ID is an immutable version. Register an updated CV under a new ID. */
export function registerResume(home, file, entry) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(entry.id || '')) throw new Error('id must contain letters, numbers, hyphens or underscores');
  if (!['zh', 'en'].includes(entry.language)) throw new Error('resume language must be zh or en');
  if (!Array.isArray(entry.tracks) || !entry.tracks.length || entry.tracks.some((t) => !TRACKS.includes(t))) throw new Error(`tracks: ${TRACKS.join(', ')}`);
  if (!Array.isArray(entry.jobTypes) || !entry.jobTypes.length || entry.jobTypes.some((t) => !['full_time', 'phd', 'cifre', 'internship'].includes(t))) throw new Error('jobTypes must specify full_time, phd, cifre or internship');
  if (!file || !/\.pdf$/i.test(file) || !statSync(file).isFile() || !readFileSync(file).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('provide an existing PDF resume');
  const library = readResumeLibrary(home);
  if (library.some((r) => r.id === entry.id)) throw new Error('resume ID already exists; use a new version ID');
  const sha256 = hash(file);
  const stored = `resumes/${entry.id}-${sha256.slice(0, 12)}.pdf`;
  mkdirSync(dirname(manifest(home)), { recursive: true });
  copyFileSync(file, join(home, stored));
  const row = { id: entry.id, language: entry.language, tracks: entry.tracks, jobTypes: entry.jobTypes,
    keywords: entry.keywords || [], file: stored, sha256, addedAt: new Date().toISOString() };
  library.push(row);
  const temp = `${manifest(home)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(library, null, 2)}\n`);
  renameSync(temp, manifest(home));
  return row;
}

export function inspectResume(home, entry) {
  if (typeof entry.file !== 'string') return '简历文件路径无效';
  const base = realpathSync(home);
  const file = resolve(home, entry.file);
  if (!existsSync(file)) return '简历文件不存在';
  const rel = relative(base, realpathSync(file));
  if (rel.startsWith('..') || isAbsolute(rel)) return '简历文件必须位于私人数据目录内';
  if (!statSync(file).isFile() || !entry.sha256 || hash(file) !== entry.sha256) return '简历文件已改变，请登记新版本';
  return null;
}

/** Never substitute a different discipline or a French CV. Missing metadata needs review. */
export function routeResume(home, profile, job) {
  const policy = checkJobPolicy(profile, job);
  const filtered = hardFilter({ filters: { excludeCompanies: [], excludeKeywords: [], requireKeywords: [], ...profile.filters } }, { company: job.company, text: job.role || job.title });
  if (filtered.length) { policy.status = 'excluded'; policy.reasons.push(...filtered); }
  const gaps = [...policy.reasons];
  if (policy.status === 'excluded') return { policy, status: 'excluded', selected: null, candidates: [], gaps };
  if (!TRACKS.includes(job.track)) gaps.push('请选择岗位方向');
  // JD language and required attachment language are separate fields.
  const language = job.resumeLanguage;
  if (!['zh', 'en'].includes(language)) gaps.push(language === 'fr' ? '岗位要求法语简历，目前只维护中文和英文版本' : '请选择简历语言 zh / en');
  if (policy.type === 'unknown' || !TRACKS.includes(job.track) || !['zh', 'en'].includes(language)) {
    return { policy, status: 'needs_review', selected: null, candidates: [], gaps };
  }
  const text = `${job.role || job.title || ''}\n${job.description || ''}`;
  const candidates = [];
  for (const resume of readResumeLibrary(home)) {
    if (resume.language !== language || !resume.tracks?.includes(job.track) || !resume.jobTypes?.includes(policy.type)) continue;
    const issue = inspectResume(home, resume);
    if (issue) { gaps.push(`${resume.id}: ${issue}`); continue; }
    const matched = (resume.keywords || []).filter((term) => containsTerm(text, term));
    candidates.push({ ...resume, matchedKeywords: matched, rank: matched.length,
      reasons: [`语言：${language}`, `方向：${job.track}`, `岗位类型：${policy.type}`] });
  }
  candidates.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  if (!candidates.length) gaps.push('缺少匹配的简历版本，请先登记对应方向、语言和岗位类型的 PDF');
  const tied = candidates.length > 1 && candidates[0].rank === candidates[1].rank;
  if (tied) gaps.push('多个版本同样匹配，请选择具体版本');
  return { policy, status: !candidates.length ? 'missing_resume' : tied || policy.status === 'review' ? 'needs_review' : 'ready',
    selected: !tied && candidates.length ? candidates[0] : null, candidates, gaps };
}
