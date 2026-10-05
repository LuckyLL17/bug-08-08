import { createHash } from 'node:crypto';

/**
 * Deterministic stable hash used to derive identifiers from business keys.
 * Retrying the same business request therefore maps to the same incident /
 * audit identifier instead of minting a fresh random id.
 */
export const stableHash = (parts: Array<string | number | undefined | null>) =>
  createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 16);

export const stableId = (prefix: string, parts: Array<string | number | undefined | null>) =>
  `${prefix}_${stableHash(parts)}`;
