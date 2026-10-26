/**
 * Where a real token's image and metadata JSON live (the `uri` in the token's
 * on-chain metadata). Behind an interface so Pinata (IPFS), Irys or anything
 * else can be plugged in.
 *
 *   pinata  permanent IPFS pinning (PINATA_JWT, PINATA_GATEWAY). Use on mainnet.
 *   self    served by this API from Postgres (PUBLIC_API_BASE_URL). Fine for
 *           devnet; on mainnet the token's art would vanish with the server.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../shared/db/pool.js';
import type { Config } from '../shared/config/config.js';

export interface MetadataStore {
  readonly kind: string;
  /**
   * Store bytes and return a public URL (at most 200 chars, the Metaplex uri cap).
   * @param name - A short label (file name).
   * @param bytes - Content.
   * @param mime - Content type.
   */
  put(name: string, bytes: Buffer, mime: string): Promise<string>;
}

/** Content-addressed id, so the same bytes give the same URL. */
export function contentId(bytes: Buffer, ext: string): string {
  return `${createHash('sha256').update(bytes).digest('hex').slice(0, 40)}.${ext}`;
}

/** Pinata v3 upload (`POST https://uploads.pinata.cloud/v3/files`, network=public). */
export function pinataStore(jwt: string, gateway: string): MetadataStore {
  return {
    kind: 'pinata',
    async put(name, bytes, mime) {
      const form = new FormData();
      form.append('network', 'public');
      form.append('name', name);
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), name);
      const res = await fetch('https://uploads.pinata.cloud/v3/files', {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}` },
        body: form,
      });
      if (!res.ok) throw new Error(`pinata upload ${res.status}`);
      const body = (await res.json()) as { data?: { cid?: string } };
      const cid = body.data?.cid;
      if (!cid) throw new Error('pinata upload: no cid');
      return `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
    },
  };
}

/** Postgres-backed store served by `GET /v1/factory/metadata/:id`. */
export function selfStore(db: Db, publicBaseUrl: string): MetadataStore {
  return {
    kind: 'self',
    async put(name, bytes, mime) {
      const ext = mime === 'application/json' ? 'json' : 'png';
      const id = contentId(bytes, ext);
      await db.withConnection((c) =>
        c.query(
          `INSERT INTO factory_metadata (id, mime, content) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [id, mime, bytes],
        ),
      );
      void name;
      return `${publicBaseUrl.replace(/\/$/, '')}/v1/factory/metadata/${id}`;
    },
  };
}

/**
 * The configured store, or null when it is not set up (launches answer 503).
 * @param cfg - The app config.
 * @param db - The pool (self store).
 * @returns The store or null.
 */
export function metadataStoreFromConfig(cfg: Config, db: Db): MetadataStore | null {
  const f = cfg.factory;
  if (f.metadataStore === 'pinata') {
    return f.pinataJwt && f.pinataGateway ? pinataStore(f.pinataJwt, f.pinataGateway) : null;
  }
  return f.publicBaseUrl ? selfStore(db, f.publicBaseUrl) : null;
}

/**
 * Read a self-stored object.
 * @param db - The pool.
 * @param id - The content id.
 * @returns Bytes and type, or null.
 */
export async function readSelfStored(
  db: Db,
  id: string,
): Promise<{ mime: string; content: Buffer } | null> {
  const r = await db.withConnection((c) =>
    c.query<{ mime: string; content: Buffer }>(
      `SELECT mime, content FROM factory_metadata WHERE id = $1`,
      [id],
    ),
  );
  return r.rows[0] ?? null;
}
