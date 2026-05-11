// =============================================================================
// Input Validator
// Validates LLM-extracted inputs against a system manifest's requiredInputs
// schema before triggering execution. Prevents hallucinated keys, type
// mismatches, missing required inputs, and prompt injection payloads.
// =============================================================================

import type { RequiredInput } from '../types/registry';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  validatedInputs: Record<string, string>;
  errors: string[];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Maximum allowed length per input value. */
const MAX_VALUE_LENGTH = 2000;

/** Regex to strip control characters (C0/C1) except common whitespace. */
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** Basic email pattern — intentionally permissive to avoid false negatives. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Validate extracted inputs against the system's declared requiredInputs.
 *
 * Rules:
 * 1. Strip keys not declared in requiredInputs (prevent hallucinated keys)
 * 2. Sanitize values: strip control chars, truncate to MAX_VALUE_LENGTH
 * 3. Check all required inputs are present and non-empty
 * 4. Type-check: number, url, email
 * 5. Return cleaned inputs on success, error list on failure
 */
export function validateExtractedInputs(
  extracted: Record<string, string>,
  requiredInputs: RequiredInput[]
): ValidationResult {
  const errors: string[] = [];
  const validatedInputs: Record<string, string> = {};

  // Build a lookup of declared input names → definitions
  const declaredInputs = new Map<string, RequiredInput>();
  for (const input of requiredInputs) {
    declaredInputs.set(input.name, input);
  }

  // 1. Filter to only declared keys and sanitize values
  for (const [key, rawValue] of Object.entries(extracted)) {
    const inputDef = declaredInputs.get(key);
    if (!inputDef) continue; // Strip hallucinated keys

    const sanitized = sanitizeValue(rawValue);
    if (sanitized.length === 0) continue; // Treat empty-after-sanitize as absent

    validatedInputs[key] = sanitized;
  }

  // 2. Check required inputs are present
  for (const input of requiredInputs) {
    if (!input.required) continue;

    const value = validatedInputs[input.name];
    if (value === undefined || value.trim().length === 0) {
      errors.push(`Missing required input: ${input.name}`);
    }
  }

  // If required inputs are missing, bail early
  if (errors.length > 0) {
    return { valid: false, validatedInputs: {}, errors };
  }

  // 3. Type validation on all present values
  for (const [key, value] of Object.entries(validatedInputs)) {
    const inputDef = declaredInputs.get(key)!;
    const typeError = validateType(key, value, inputDef.type);
    if (typeError) {
      errors.push(typeError);
    }
  }

  if (errors.length > 0) {
    return { valid: false, validatedInputs: {}, errors };
  }

  return { valid: true, validatedInputs, errors: [] };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** Strip control characters and truncate to MAX_VALUE_LENGTH. */
function sanitizeValue(raw: unknown): string {
  if (typeof raw !== 'string') {
    return String(raw ?? '');
  }
  const cleaned = raw.replace(CONTROL_CHAR_RE, '');
  if (cleaned.length > MAX_VALUE_LENGTH) {
    return cleaned.slice(0, MAX_VALUE_LENGTH);
  }
  return cleaned;
}

/** Validate a value against its declared type. Returns error string or null. */
function validateType(name: string, value: string, type: string): string | null {
  switch (type) {
    case 'number': {
      const num = Number(value);
      if (isNaN(num)) {
        return `Invalid number for input "${name}": "${value}"`;
      }
      return null;
    }

    case 'url': {
      if (!value.startsWith('http://') && !value.startsWith('https://')) {
        return `Invalid URL for input "${name}": must start with http:// or https://`;
      }
      try {
        new URL(value);
      } catch {
        return `Invalid URL for input "${name}": "${value}"`;
      }
      return null;
    }

    case 'email': {
      if (!EMAIL_RE.test(value)) {
        return `Invalid email for input "${name}": "${value}"`;
      }
      return null;
    }

    // 'string' and any other custom types pass through without validation
    default:
      return null;
  }
}
