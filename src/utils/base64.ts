/**
 * Base64 for binary payloads.
 *
 * `btoa` is present in browsers, extension workers and Node's global scope, so
 * one implementation serves every surface. Chunking matters: spreading a
 * multi-megabyte array into `String.fromCharCode` overflows the argument list.
 */

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
