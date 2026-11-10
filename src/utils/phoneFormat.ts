/**
 * US Phone Number Formatting and E.164 Validation Utilities
 */

export function cleanDigits(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Formats raw digits into US phone format: +1 (XXX) XXX-XXXX
 * Robust against editing and backspacing without prepending duplicate '1's.
 */
export function formatUsPhoneDisplay(input: string): string {
  if (!input || !input.trim()) return '';

  let digits = cleanDigits(input);

  // If user cleared everything or just left with non-digits
  if (!digits) {
    if (input.trim() === '+' || input.trim() === '+1') return input.trim();
    return '';
  }

  // If 11 digits starting with 1, strip country code 1 so we get 10-digit national number
  if (digits.length >= 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }

  // Cap at 10 national digits
  const national = digits.slice(0, 10);

  if (national.length === 0) return '';
  if (national.length <= 3) return `+1 (${national}`;
  if (national.length <= 6) return `+1 (${national.slice(0, 3)}) ${national.slice(3)}`;
  return `+1 (${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6, 10)}`;
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

  // Strip leading US country code 1
  if (digits.startsWith('1')) {
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
