import type { PoolClient } from 'pg';

/** Always acquire address before user/challenge locks in cross-table claims. */
export async function lockWalletOwnership(
  client: PoolClient,
  network: string,
  address: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `ctlife:wallet-owner:${network}:${address}`,
  ]);
}
