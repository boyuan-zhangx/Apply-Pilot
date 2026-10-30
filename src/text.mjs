// CJK terms do not have whitespace word boundaries. Latin terms still do.
export const fold = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function containsTerm(text, term) {
  const needle = fold(term).trim();
  if (!needle) return false;
  if (/\p{Script=Han}/u.test(needle)) return fold(text).includes(needle);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(needle)}(?=[^\\p{L}\\p{N}]|$)`, 'u').test(fold(text));
}
