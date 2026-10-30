import { fold } from './text.mjs';

export const JOB_TYPES = ['full_time', 'phd', 'cifre', 'internship'];
const employerKey = (name) => fold(name).replace(/[.,]/g, '').replace(/\b(incorporated|corporation|limited|inc|corp|ltd|llc)\b/g, '').replace(/\s+/g, ' ').trim();

/** Classify the advertised role, never qualifications or past internships in a JD. */
export function classifyJob(job = {}) {
  const title = fold(job.role || job.title || '');
  if (/\b(intern(ship)?|stagiaire|stage|praktikum)\b|实习/.test(title)) return 'internship';
  if (/\bcifre\b/.test(title)) return 'cifre';
  if (/\b(doctoral|doctorant\w*|these)\b|\bph\.?d\.?\s*(position|student|candidate|scholarship|in\b)|^ph\.?d\.?$|博士(生|招生|研究生|职位|岗位)|招收博士/.test(title)) return 'phd';
  const explicit = job.jobType || job.employmentType;
  if (JOB_TYPES.includes(explicit)) return explicit;
  if (/\b(full[ -]?time|permanent|cdi|cdd)\b|全职|正职|正式员工/.test(title)) return 'full_time';
  return 'unknown';
}

export function checkJobPolicy(profile, job = {}) {
  const type = classifyJob(job);
  const policy = profile.jobPolicy;
  if (!policy?.enabled) return { type, status: 'allowed', reasons: [] };
  if (type === 'unknown') return { type, status: 'review', reasons: ['岗位类型待确认（正职 / 博士 / CIFRE / 实习）'] };
  if (type === 'internship') {
    const key = employerKey(job.company || '');
    if (!key) return { type, status: 'review', reasons: ['实习雇主待确认，无法核对公司白名单'] };
    const allowed = (policy.internshipCompanies || []).some((entry) => {
      const names = typeof entry === 'string' ? [entry] : [entry.name, ...(entry.aliases || [])];
      return names.some((name) => name && employerKey(name) === key);
    });
    return allowed
      ? { type, status: 'review', reasons: ['白名单实习：需核实在读身份及实习资格要求'] }
      : { type, status: 'excluded', reasons: ['实习公司不在白名单中'] };
  }
  return (policy.allowedTypes || ['full_time', 'phd', 'cifre']).includes(type)
    ? { type, status: 'allowed', reasons: [] }
    : { type, status: 'excluded', reasons: ['岗位类型不在允许列表中'] };
}
