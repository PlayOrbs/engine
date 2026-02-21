/**
 * Universal SHA-256 hashing utilities for Node.js
 * Uses Web Crypto API for consistency with browser
 * 
 * IMPORTANT: Uses same canonical JSON algorithm as browser version
 * to ensure identical hashes across all systems.
 * 
 * Requires Node.js 15+ for Web Crypto API support.
 */

/**
 * Canonicalize JSON by sorting keys recursively
 * Ensures deterministic output regardless of key insertion order
 * 
 * MUST match browser implementation exactly!
 */
function canonicalizeJSON(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJSON).join(',') + ']';
  }
  
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(key => `"${key}":${canonicalizeJSON(obj[key])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Compute SHA-256 hash of a string
 * 
 * @param input - String to hash
 * @param short - If true, return first 8 hex chars (4 bytes)
 * @returns Hex-encoded SHA-256 hash
 */
export async function sha256(input: string, short: boolean = false): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return short ? hex.slice(0, 8) : hex;
}

/**
 * Compute SHA-256 hash of a JSON object
 * Uses canonical JSON (sorted keys) for deterministic hashing
 * 
 * @param obj - Object to hash
 * @param short - If true, return first 8 hex chars (4 bytes)
 * @returns Hex-encoded SHA-256 hash
 */
export async function sha256JSON(obj: any, short: boolean = false): Promise<string> {
  const canonical = canonicalizeJSON(obj);
  return sha256(canonical, short);
}

/**
 * Get both full and short hash versions for JSON
 * 
 * @param obj - Object to hash
 * @returns Object with full (64 chars) and short (8 chars) hashes
 */
export async function sha256JSONBoth(obj: any): Promise<{ full: string; short: string }> {
  const canonical = canonicalizeJSON(obj);
  const full = await sha256(canonical, false);
  return {
    full,
    short: full.slice(0, 8),
  };
}
