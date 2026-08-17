/**
 * Runtime validation for model output.
 *
 * Model prose is never trusted directly. Providers are asked for structured
 * JSON and every field is checked here before it can become a scene beat. When
 * validation fails the response is discarded and the local heuristics stand —
 * FrameScript would rather have a thinner screenplay than a confident wrong one.
 *
 * Hand-written rather than pulled from a schema library: the extension ships
 * every byte it executes, and this is a few hundred lines against a dependency.
 */

export type ValidationIssue = { path: string; message: string };

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export interface Validator<T> {
  validate(value: unknown, path?: string): ValidationResult<T>;
}

const ok = <T>(value: T): ValidationResult<T> => ({ ok: true, value });
const fail = (path: string, message: string): ValidationResult<never> => ({
  ok: false,
  issues: [{ path, message }],
});

export const v = {
  string(options: { min?: number; max?: number; trim?: boolean } = {}): Validator<string> {
    return {
      validate(value, path = '$') {
        if (typeof value !== 'string') return fail(path, 'expected string');
        const out = options.trim === false ? value : value.trim();
        if (options.min !== undefined && out.length < options.min) {
          return fail(path, `expected at least ${options.min} characters`);
        }
        if (options.max !== undefined && out.length > options.max) {
          // Truncate rather than reject: an over-long description is still useful.
          return ok(out.slice(0, options.max));
        }
        return ok(out);
      },
    };
  },

  number(options: { min?: number; max?: number; integer?: boolean } = {}): Validator<number> {
    return {
      validate(value, path = '$') {
        const n = typeof value === 'string' ? Number(value) : value;
        if (typeof n !== 'number' || !Number.isFinite(n)) return fail(path, 'expected finite number');
        if (options.integer && !Number.isInteger(n)) return fail(path, 'expected integer');
        if (options.min !== undefined && n < options.min) return fail(path, `expected >= ${options.min}`);
        if (options.max !== undefined && n > options.max) return fail(path, `expected <= ${options.max}`);
        return ok(n);
      },
    };
  },

  boolean(): Validator<boolean> {
    return {
      validate(value, path = '$') {
        if (typeof value !== 'boolean') return fail(path, 'expected boolean');
        return ok(value);
      },
    };
  },

  literalUnion<const T extends readonly string[]>(values: T): Validator<T[number]> {
    return {
      validate(value, path = '$') {
        if (typeof value !== 'string' || !values.includes(value)) {
          return fail(path, `expected one of: ${values.join(', ')}`);
        }
        return ok(value as T[number]);
      },
    };
  },

  array<T>(item: Validator<T>, options: { max?: number; skipInvalid?: boolean } = {}): Validator<T[]> {
    return {
      validate(value, path = '$') {
        if (!Array.isArray(value)) return fail(path, 'expected array');
        const limited = options.max !== undefined ? value.slice(0, options.max) : value;
        const out: T[] = [];
        const issues: ValidationIssue[] = [];
        limited.forEach((entry, index) => {
          const result = item.validate(entry, `${path}[${index}]`);
          if (result.ok) out.push(result.value);
          else issues.push(...result.issues);
        });
        // Partial credit: one malformed action should not discard the other four.
        if (issues.length > 0 && options.skipInvalid !== true) return { ok: false, issues };
        return ok(out);
      },
    };
  },

  object<S extends Record<string, Validator<unknown>>>(
    shape: S,
    optionalKeys: readonly (keyof S)[] = [],
  ): Validator<{ [K in keyof S]: S[K] extends Validator<infer U> ? U : never }> {
    const optional = new Set(optionalKeys as string[]);
    return {
      validate(value, path = '$') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return fail(path, 'expected object');
        }
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        const issues: ValidationIssue[] = [];

        for (const [key, validator] of Object.entries(shape)) {
          const raw = source[key];
          if (raw === undefined || raw === null) {
            if (!optional.has(key)) issues.push({ path: `${path}.${key}`, message: 'missing required field' });
            continue;
          }
          const result = validator.validate(raw, `${path}.${key}`);
          if (result.ok) out[key] = result.value;
          else issues.push(...result.issues);
        }
        if (issues.length > 0) return { ok: false, issues };
        return ok(out as never);
      },
    };
  },
};

/**
 * Extracts JSON from a model response.
 *
 * Models routinely wrap JSON in prose or a fenced block even when told not to.
 * Recovering the object is worthwhile; *guessing* at malformed JSON is not, so
 * this only ever returns something `JSON.parse` accepted.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const parsed = tryParse(trimmed.slice(first, last + 1));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function formatIssues(issues: readonly ValidationIssue[], limit = 5): string {
  return issues
    .slice(0, limit)
    .map((i) => `${i.path}: ${i.message}`)
    .join('; ');
}
