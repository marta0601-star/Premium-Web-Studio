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

/**
 * Expand a UPC-E (8-digit: number-system + 6 data + check) into the equivalent
 * UPC-A (12-digit). The expansion is driven by the 6th data digit per the GS1
 * spec; the check digit is shared between UPC-E and UPC-A, so we keep it and let
 * the caller re-validate it through {@link isValidEAN} on the zero-prefixed form.
 *
 * Returns null for anything that isn't a well-formed UPC-E (wrong length,
 * non-digits, or a number system other than 0/1, the only values UPC-E defines).
 */
export function expandUpcE(upce: string): string | null {
  if (!/^\d{8}$/.test(upce)) return null;
  const ns = upce[0];
  if (ns !== "0" && ns !== "1") return null;
  const d = upce.slice(1, 7); // X1..X6
  const check = upce[7];
  const last = d[5];
  let middle: string; // the 10 digits between number-system and check digit
  switch (last) {
    case "0":
    case "1":
    case "2":
      middle = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
      break;
    case "3":
      middle = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
      break;
    case "4":
      middle = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
      break;
    default: // 5,6,7,8,9
      middle = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
      break;
  }
  return `${ns}${middle}${check}`; // 1 + 10 + 1 = 12 digits
}

/**
 * Normalise any raw scanner payload to a canonical GTIN we accept, or null.
 *
 * The decoders emit EAN-13 (13), EAN-8 (8), UPC-A (12) and UPC-E (8). UPC-A and
 * UPC-E are GS1 retail codes too, but {@link isValidEAN} only knows the 8/13
 * lengths, so without this they were silently dropped by the scanner. We fold
 * them into EAN-13 (UPC-A is just a zero-prefixed EAN-13; UPC-E expands to
 * UPC-A → EAN-13) and gate everything through the EAN check digit, so a misread
 * can never slip through — it just returns null and the frame is ignored.
 *
 * Both scanner engines (native BarcodeDetector + ZXing) feed through here before
 * the 2×-stable-read guard, so the streak comparison always sees the same
 * canonical form regardless of which symbology produced it.
 *
 * `formatHint` is the decoder-reported symbology (e.g. "upc_e", "EAN-8",
 * "UPC-A"). It disambiguates the 8-digit case: an 8-digit payload is ambiguous
 * between EAN-8 and UPC-E, and ~58 % of real UPC-E codes also satisfy the EAN-8
 * checksum, so a checksum-only guess would mis-normalise them. When the decoder
 * tells us it's UPC-E we expand; when it says EAN-8 we keep it; only when the
 * format is unknown do we fall back to checksum-order guessing.
 */
function hintIsUpcE(hint?: string): boolean {
  return /upc[_-]?e/i.test(hint ?? "");
}
function hintIsEan8(hint?: string): boolean {
  return /ean[_-]?8/i.test(hint ?? "");
}

export function normalizeBarcode(raw: string, formatHint?: string): string | null {
  const code = raw.replace(/\D/g, "");
  if (code.length === 13) {
    return isValidEAN(code) ? code : null;
  }
  if (code.length === 12) {
    const ean13 = `0${code}`; // UPC-A → EAN-13
    return isValidEAN(ean13) ? ean13 : null;
  }
  if (code.length === 8) {
    const fromUpcE = (): string | null => {
      const upca = expandUpcE(code); // UPC-E → UPC-A → EAN-13
      if (!upca) return null;
      const ean13 = `0${upca}`;
      return isValidEAN(ean13) ? ean13 : null;
    };
    // Trust the decoder's symbology when it gives one.
    if (hintIsUpcE(formatHint) && !hintIsEan8(formatHint)) return fromUpcE();
    if (hintIsEan8(formatHint)) return isValidEAN(code) ? code : null;
    // Unknown format → best effort: genuine EAN-8 first, else try UPC-E.
    if (isValidEAN(code)) return code;
    return fromUpcE();
  }
  return null;
}
