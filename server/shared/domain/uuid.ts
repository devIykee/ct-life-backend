/**
 * UUIDv7 generator (time-ordered). Used for every server-generated entity
 * ID: users, characters, intents, trades, perps, calls, messages, etc.
 *
 * The format: 48 bits of Unix epoch milliseconds + 80 bits of randomness
 * + version/variant bits. Implemented without external deps.
 */
/**
 * Generate a UUIDv7 (time-ordered) using the given epoch ms (defaults to now).
 *
 * Format: 48-bit timestamp + 80-bit randomness + version 7 + variant 10.
 *
 * @param now - Epoch milliseconds; defaults to Date.now().
 * @returns The UUIDv7 string.
 */
export function uuidv7(now: number = Date.now()): string {
  // 48-bit timestamp (milliseconds since Unix epoch).
  const timeHex = now.toString(16).padStart(12, '0');

  // 80 random bits. crypto.getRandomValues gives us 80 bits.
  const rnd = new Uint8Array(10);
  crypto.getRandomValues(rnd);
  let rndHex = '';
  for (const b of rnd) rndHex += b.toString(16).padStart(2, '0');

  // Set version (7) in the high 4 bits of byte 6 (the 13th hex digit).
  // Set variant (10) in the high 2 bits of byte 8 (the 17th hex digit).
  // The 80 random bits start at position 12 in the hex string (after the
  // 48-bit timestamp). Bytes 6-7 are at hex positions 12-15.
  const rndChars = rndHex.split('');
  // version 7 -> '7'
  rndChars[0] = '7';
  // variant 10 -> 'a' or 'b'; use 'a'
  rndChars[2] = 'a';

  const uuid = `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-${rndChars.slice(0, 4).join('')}-${rndChars.slice(4, 8).join('')}-${rndChars.slice(8, 20).join('')}`;
  return uuid;
}

/** Generate a UUIDv4. Used only for the Idempotency-Key header. */
export function uuidv4(): string {
  // crypto.randomUUID is available in Node 19+ and returns a v4 UUID.
  return crypto.randomUUID();
}
