/**
 * US Phone Number Formatting and E.164 Validation Utilities
 */

export function cleanDigits(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Formats raw digits into US phone format: +1 (XXX) XXX-XXXX
 */
export function formatUsPhoneDisplay(input: string): string {
  let digits = cleanDigits(input);

  // Strip an explicit +1 prefix at every input length so partial typing keeps
  // the country code out of the local number. Also accept a full 11-digit 1 prefix.
  if (/^\s*\+1\b/.test(input) || (digits.startsWith('1') && digits.length > 10)) {
    digits = digits.slice(1);
  }

  // Cap at 10 digits
  const trimmed = digits.slice(0, 10);

  if (trimmed.length === 0) return '';
  if (trimmed.length <= 3) return `+1 (${trimmed}`;
  if (trimmed.length <= 6) return `+1 (${trimmed.slice(0, 3)}) ${trimmed.slice(3)}`;
  return `+1 (${trimmed.slice(0, 3)}) ${trimmed.slice(3, 6)}-${trimmed.slice(6, 10)}`;
}

/**
 * Validates whether the number is a valid 10-digit North American Numbering Plan (NANP) phone
 * Area code cannot begin with 0 or 1, central office code cannot begin with 0 or 1.
 */
export function validateUsPhoneNumber(input: string): {
  isValid: boolean;
  e164: string;
  error?: string;
} {
  let digits = cleanDigits(input);

  if (digits.startsWith('1') && digits.length === 11) {
    digits = digits.slice(1);
  }

  if (digits.length === 0) {
    return { isValid: false, e164: '', error: 'Phone number is required.' };
  }

  if (digits.length < 10) {
    return {
      isValid: false,
      e164: '',
      error: `Incomplete number (${digits.length}/10 digits).`,
    };
  }

  if (digits.length > 10) {
    return {
      isValid: false,
      e164: '',
      error: 'Too many digits for standard US number.',
    };
  }

  // Check area code (first digit cannot be 0 or 1)
  if (digits[0] === '0' || digits[0] === '1') {
    return {
      isValid: false,
      e164: '',
      error: 'US area codes cannot start with 0 or 1.',
    };
  }

  // Check central office code (4th digit cannot be 0 or 1)
  if (digits[3] === '0' || digits[3] === '1') {
    return {
      isValid: false,
      e164: '',
      error: 'Central office code cannot start with 0 or 1.',
    };
  }

  return {
    isValid: true,
    e164: `+1${digits}`,
  };
}
