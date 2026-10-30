import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkJobPolicy, classifyJob } from '../src/job-policy.mjs';
import { findDuplicates, normalizeUrl } from '../src/tracker.mjs';
import { hardFilter } from '../src/scoring.mjs';
import { lintText } from '../src/lint.mjs';
import { finishEvaluation } from '../src/evaluate.mjs';
import { triage } from '../src/triage.mjs';
import { registerResume, routeResume, readResumeLibrary } from '../src/resumes.mjs';

const profile = JSON.parse(readFileSync(new URL('../examples/cn-eu-careers/profile.json', import.meta.url)));
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'ap-personal-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const cv = (home, options = {}) => {
  const file = join(home, 'source.pdf'); writeFileSync(file, '%PDF-1.4\nsynthetic test fixture');
  return registerResume(home, file, { id: 'robotics-en-v1', language: 'en', tracks: ['robotics'], jobTypes: ['full_time', 'phd', 'cifre', 'internship'], ...options });
};
const job = { company: 'Example', role: 'Robotics Engineer', jobType: 'full_time', track: 'robotics', resumeLanguage: 'en' };

test('internships are excluded except exact employer allowlist aliases; student eligibility still needs review', () => {
  for (const company of ['NVIDIA', 'NVIDIA Corporation', '英伟达', 'Meta Platforms, Inc.', 'Google LLC']) {
    assert.equal(checkJobPolicy(profile, { company, role: 'Research Intern, PhD' }).status, 'review', company);
  }
  for (const company of ['Example', 'NVIDIA supplier', 'Google recruiter agency', 'Metaverse']) {
    assert.equal(checkJobPolicy(profile, { company, role: 'Research Intern' }).status, 'excluded', company);
  }
  assert.equal(checkJobPolicy(profile, { role: 'Intern' }).status, 'review');
});

test('type detection prioritizes internships over PhD keywords and structured labels', () => {
  assert.equal(classifyJob({ role: 'PhD Research Intern', jobType: 'phd' }), 'internship');
  assert.equal(classifyJob({ role: '博士实习生', jobType: 'full_time' }), 'internship');
  assert.equal(classifyJob({ role: '博士研究生 招生' }), 'phd');
  assert.equal(classifyJob({ role: 'Thèse CIFRE robotique' }), 'cifre');
  assert.equal(classifyJob({ role: 'Internal auditor' }), 'unknown');
  assert.equal(classifyJob({ role: 'Full-time engineer', description: 'Previous internship or PhD welcome' }), 'full_time');
  assert.equal(checkJobPolicy(profile, { role: 'Engineer' }).status, 'review');
});

test('high ratings cannot override excluded internships or unknown contracts', () => {
  const ratings = Object.fromEntries(profile.scoring.dimensions.map(d => [d.id, 5]));
  assert.equal(finishEvaluation(profile, { company: 'Other', role: 'Intern', ratings }).decision, 'Skip');
  const unclear = finishEvaluation(profile, { company: 'Other', role: 'Engineer', ratings });
  assert.equal(unclear.decision, 'Consider'); assert.equal(unclear.needsReview, true);
});

test('triage applies policy and preserves uncertain roles for review', () => {
  const scan = { jobs: [{ company: 'Other', title: '实习工程师', url: 'https://example.test/1' }, { company: 'Google', title: 'Research Intern', url: 'https://example.test/2' }, { company: 'Lab', title: 'PhD position in robotics', url: 'https://example.test/3' }] };
  const result = triage(scan, [], profile);
  assert.equal(result.filtered.length, 1); assert.equal(result.fresh.length, 2);
  assert.equal(result.fresh[0].needsReview, true); assert.equal(result.fresh[1].policy.type, 'phd');
});

test('Chinese filters work without spaces; Latin boundaries remain intact', () => {
  const p = { filters: { excludeCompanies: ['CEA'], excludeKeywords: ['销售'], requireKeywords: [] } };
  assert.deepEqual(hardFilter(p, { company: 'Ceapro', text: '导航工程师' }), []);
  assert.equal(hardFilter(p, { text: '销售工程师' }).length, 1);
});

test('Chinese duplicate detection works across sources and keeps distinct company names', () => {
  const row = { company: '高仙', role: '导航算法工程师', url: 'https://one.test/1' };
  assert.equal(findDuplicates([row], { ...row, url: 'https://two.test/2' }).length, 1);
  assert.equal(findDuplicates([row], { ...row, company: '高仙供应商', url: 'https://two.test/2' }).length, 0);
});

test('job IDs, case-sensitive paths and SPA routes are preserved while tracking is stripped', () => {
  assert.equal(normalizeUrl('https://example.test/job?id=1&utm_source=foo'), normalizeUrl('https://example.test/job?id=1'));
  for (const [a,b] of [['?id=1','?id=2'], ['#/job/1','#/job/2'], ['/AbC','/abc']]) {
    const row = { company: 'Example', role: 'Engineer', url: 'https://example.test/job'+a };
    assert.equal(findDuplicates([row], { ...row, url: 'https://example.test/job'+b }).length, 0);
  }
});

test('Chinese claims are flagged but targeted negations are allowed', () => {
  const p = { writing: { forbiddenClaims: ['芯片流片'] } };
  assert.equal(lintText('我有芯片流片经验。', p).issues.length, 1);
  assert.equal(lintText('我尚未掌握芯片流片。', p).issues.length, 0);
  assert.equal(lintText('我没有管理经验，但我主导了芯片流片。', p).issues.length, 1);
});

test('resume registration copies a version and does not overwrite source or an existing ID', t => {
  const home = temp(t), row = cv(home);
  assert.equal(readResumeLibrary(home).length, 1);
  assert.equal(readFileSync(join(home, row.file), 'utf8'), readFileSync(join(home, 'source.pdf'), 'utf8'));
  assert.throws(() => cv(home), /already exists/);
  assert.throws(() => cv(home, { id: '../bad' }), /id must/);
  assert.throws(() => cv(home, { id: 'fr-v1', language: 'fr' }), /zh or en/);
});

test('routing requires both role type and discipline, without changing language for a French JD', t => {
  const home = temp(t); cv(home);
  assert.equal(routeResume(home, profile, { ...job, description: 'Ingénieur robotique', language: 'fr' }).status, 'ready');
  assert.equal(routeResume(home, profile, { ...job, track: 'mathematics', jobType: 'phd' }).status, 'missing_resume');
  assert.equal(routeResume(home, profile, { ...job, track: 'product' }).selected, null);
  assert.equal(routeResume(home, profile, { ...job, resumeLanguage: 'fr' }).status, 'needs_review');
  assert.equal(routeResume(home, profile, { ...job, jobType: 'unknown' }).selected, null);
});

test('ties require user choice, explicit keywords can distinguish versions', t => {
  const home = temp(t); cv(home); cv(home, { id: 'robotics-en-v2', keywords: ['SLAM'] });
  assert.equal(routeResume(home, profile, job).selected, null);
  assert.equal(routeResume(home, profile, { ...job, description: 'SLAM mapping' }).selected.id, 'robotics-en-v2');
});

test('changed or missing resume files cannot be recommended', t => {
  const home = temp(t), row = cv(home);
  writeFileSync(join(home, row.file), '%PDF-1.4\nchanged');
  assert.equal(routeResume(home, profile, job).status, 'missing_resume');
  rmSync(join(home, row.file));
  assert.equal(routeResume(home, profile, job).selected, null);
});

test('manifest cannot route a file outside the data folder', t => {
  const dir = temp(t), home = join(dir, 'private'); mkdirSync(home);
  const row = cv(home); writeFileSync(join(dir, 'outside.pdf'), readFileSync(join(home, row.file)));
  writeFileSync(join(home, 'resumes/index.json'), JSON.stringify([{ ...row, file: '../outside.pdf' }]));
  assert.equal(routeResume(home, profile, job).selected, null);
});

test('blocked internship never recommends or reads a resume library', t => {
  const home = temp(t);
  const result = routeResume(home, profile, { ...job, role: 'Research intern' });
  assert.equal(result.status, 'excluded'); assert.equal(result.selected, null);
});
