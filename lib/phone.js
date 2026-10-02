/** → '+359XXXXXXXX(X)' for Bulgarian numbers, '+<digits>' for other international ones, otherwise null. */
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/[^\d+]/g, '');
  let international = false;
  if (d.startsWith('+')) { d = d.slice(1); international = true; }
  else if (d.startsWith('00')) { d = d.slice(2); international = true; }
  else if (d.startsWith('0')) d = `359${d.slice(1)}`;
  else if (/^[89]\d{8}$/.test(d)) d = `359${d}`;
  if (d.includes('+')) return null;
  // Drop trunk zero after country code: +359 0... → 359...
  if (d.startsWith('3590')) d = d.slice(0, 3) + d.slice(4);
  // Bulgarian numbers must match the pattern
  if (d.startsWith('359')) return /^359\d{8,9}$/.test(d) ? `+${d}` : null;
  if (international && /^[1-9]\d{7,14}$/.test(d)) return `+${d}`;
  return null;
}
