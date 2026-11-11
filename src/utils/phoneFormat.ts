/**
 * US Phone Number Validation & Normalization Utilities
 * Zero-mutation design: never injects '+1' or formatting characters into active user typing.
 */

export function cleanDigits(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Formats a 10-digit national string into (XXX) XXX-XXXX for read-only display previews.
 */
export function formatUsPhoneDisplay(input: string): string {
  if (!input || !input.trim()) return '';
  const trimmed = input.trim();
  const withoutPlusOne = trimmed.startsWith('+1') ? trimmed.slice(2) : trimmed;
  let digits = cleanDigits(withoutPlusOne);

  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  const national = digits.slice(0, 10);

  if (national.length === 0) return '';
  if (national.length <= 3) return national;
  if (national.length <= 6) return `(${national.slice(0, 3)}) ${national.slice(3)}`;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6, 10)}`;
}

/**
 * Normalizes a caller ID or E.164 phone input (e.g., for carrier settings).
 * Converts 10-digit US numbers to +1XXXXXXXXXX and 11-digit 1XXXXXXXXXX to +1XXXXXXXXXX.
 */
export function normalizeE164Phone(input: string): string {
  if (!input || !input.trim()) return '';
  const digits = cleanDigits(input.trim());
  if (!digits) return '';

  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return `+${digits}`;
}

/**
 * Validates whether the number is a valid US phone number (accepts 10 digits,
 * 11 digits starting with '1', or '+1' E.164 format).
 * Area code (1st national digit) and central office code (4th national digit) cannot start with 0 or 1.
 */
export function validateUsPhoneNumber(input: string): {
  isValid: boolean;
  e164: string;
  formattedNational?: string;
  error?: string;
} {
  if (!input || !input.trim()) {
    return { isValid: false, e164: '', error: 'Phone number is required.' };
  }

  const trimmed = input.trim();
  const hasExplicitPlusOne = trimmed.startsWith('+1');
  const withoutPlusOne = hasExplicitPlusOne ? trimmed.slice(2) : trimmed;
  let digits = cleanDigits(withoutPlusOne);

  if (digits.length === 0) {
    return {
      isValid: false,
      e164: '',
      error: hasExplicitPlusOne ? 'Enter 10-digit US number after +1.' : 'Phone number is required.',
    };
  }

  // Allow typing an 11-digit US number starting with country code '1' (e.g. 13055551234)
  if (!hasExplicitPlusOne && digits.startsWith('1')) {
    if (digits.length < 11) {
      return {
        isValid: false,
        e164: '',
        error:
          digits.length === 10
            ? 'US area codes cannot start with 1 (or enter all 11 digits if starting with country code 1).'
            : `Typing with country code 1 (${digits.length}/11 digits) — or omit leading 1 for 10 digits.`,
      };
    }
    if (digits.length === 11) {
      digits = digits.slice(1);
    }
  }

  if (digits[0] === '0' || digits[0] === '1') {
    return {
      isValid: false,
      e164: '',
      error: 'US area codes cannot start with 0 or 1.',
    };
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
      error: 'Too many digits (enter 10-digit US number).',
    };
  }

  if (digits[3] === '0' || digits[3] === '1') {
    return {
      isValid: false,
      e164: '',
      error: 'Central office code (4th digit) cannot start with 0 or 1.',
    };
  }

  return {
    isValid: true,
    e164: `+1${digits}`,
    formattedNational: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`,
  };
}
