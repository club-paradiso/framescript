/**
 * Identifier helpers.
 *
 * Evidence and screenplay identifiers must be stable across a session so that
 * provenance references survive re-rendering, and monotonic so that ordering
 * ties break deterministically. Tests need reproducibility, hence the
 * injectable counter factory.
 */

export function createIdFactory(prefix: string, start = 0): () => string {
  let n = start;
  return () => `${prefix}-${(++n).toString(36).padStart(4, '0')}`;
}

/**
 * Deterministic 32-bit FNV-1a hash. Used for content identity fingerprints and
 * for stable synthetic ids derived from source data (not for security).
 */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shortHash(input: string): string {
  return hash32(input).toString(36);
}

/** Random id for session-scoped objects that need no reproducibility. */
export function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return `${prefix}-${out}`;
}
