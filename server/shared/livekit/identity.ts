/** Public media resource identifiers contain no wallet addresses or bearer credentials. */
export interface MediaCredential {
  readonly userId: string;
  readonly identityId: string;
  readonly version: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY_UUID = '00000000-0000-0000-0000-000000000000';

/** A canonical player/credential identifier, not a permissive UUID coercion. */
export function isMediaUuid(value: string): boolean {
  return UUID.test(value) && value !== EMPTY_UUID;
}

/** One LiveKit participant per login credential generation, independent of player-level state. */
export function mediaIdentity(credential: MediaCredential): string {
  if (
    !isMediaUuid(credential.userId) ||
    !isMediaUuid(credential.identityId) ||
    !Number.isSafeInteger(credential.version) ||
    credential.version < 0 ||
    credential.version > 2147483647
  )
    throw new Error('Invalid media credential scope');
  return `ct1:${credential.userId}:${credential.identityId}:${credential.version}`;
}

/** Parse only qualified identities. Legacy player IDs carry no credential authority. */
export function parseMediaIdentity(value: string): MediaCredential | null {
  if (value.length < 79 || value.length > 88 || !value.startsWith('ct1:')) return null;
  const parts = value.split(':');
  if (parts.length !== 4 || !isMediaUuid(parts[1]!) || !isMediaUuid(parts[2]!)) return null;
  const generation = parts[3]!;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(generation)) return null;
  const version = Number(generation);
  if (version > 2147483647) return null;
  return { userId: parts[1]!, identityId: parts[2]!, version };
}

/** Player-level bookkeeping may recognise old grants, but must never treat them as credentials. */
export function mediaPlayerId(value: string): string | null {
  return parseMediaIdentity(value)?.userId ?? (isMediaUuid(value) ? value : null);
}
