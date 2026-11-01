/**
 * Conditional GET: does a request's `If-None-Match` match the current ETag?
 *
 * RFC 9110 section 13.1.2: `If-None-Match` uses the weak comparison, so `W/"x"` matches
 * `"x"`. This matters in production: Railway's edge gzips responses and rewrites the
 * strong tag we send (`"x"`) to `W/"x"`, and clients echo back the tag they were given.
 * The header may list several tags (`"a", W/"b"`) or be `*` (any current representation).
 */

/** One entity-tag in a list: optional `W/` prefix, then a quoted opaque tag. */
const ENTITY_TAG = /(?:W\/)?("[^"]*")/g;

/**
 * Strip the weak prefix, leaving the quoted opaque tag.
 * @param tag - An entity-tag such as `"x"` or `W/"x"`.
 * @returns The opaque tag (`"x"`).
 */
function opaqueTag(tag: string): string {
  return tag.trim().replace(/^W\//, '');
}

/**
 * Whether an `If-None-Match` header matches `etag` under the weak comparison.
 * @param header - The raw header (a duplicated header may arrive as an array).
 * @param etag - The current ETag of the representation, as sent in `ETag`.
 * @returns True when the client already holds this representation (answer `304`).
 */
export function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.trim() === '*') return true;
  const want = opaqueTag(etag);
  for (const m of value.matchAll(ENTITY_TAG)) {
    if (m[1] === want) return true;
  }
  return false;
}
