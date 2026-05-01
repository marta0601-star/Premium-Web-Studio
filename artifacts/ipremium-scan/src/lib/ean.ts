/**
 * EAN-13 / EAN-8 checksum validator.
 *
 * Returns true only when the code is exactly 8 or 13 digits AND the trailing
 * check digit matches the modulo-10 weighted sum of the preceding digits.
 *
 * Weights for EAN-13: positions 0,2,4,…,10 ×1; positions 1,3,…,11 ×3.
 * Weights for EAN-8 : positions 0,2,4, 6   ×3; positions 1,3,5    ×1.
 *
 * Non-digit input falls through to `parseInt → NaN`, which fails the final
 * equality check, so the function correctly rejects junk like "abc12345".
 */
export function isValidEAN(code: string): boolean {
  if (code.length !== 8 && code.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < code.length - 1; i++) {
    const digit = parseInt(code[i]);
    if (code.length === 13) {
      sum += i % 2 === 0 ? digit : digit * 3;
    } else {
      sum += i % 2 === 0 ? digit * 3 : digit;
    }
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(code[code.length - 1]);
}
