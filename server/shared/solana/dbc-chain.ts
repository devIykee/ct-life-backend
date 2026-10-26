/**
 * The on-chain side of real Factory launches: Meteora Dynamic Bonding Curve
 * (`@meteora-ag/dynamic-bonding-curve-sdk` 2.0.0, program
 * dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN on devnet and mainnet).
 *
 * Kept behind an interface so the application layer can be tested without a
 * cluster. The server never holds a funded key: the player's wallet pays and
 * signs; the only server-side signer is each launch's fresh mint keypair.
 */
import { Connection, PublicKey, type Transaction } from '@solana/web3.js';
import {
  DynamicBondingCurveClient,
  getPriceFromSqrtPrice,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

export const DBC_PROGRAM_ID = DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58();

export interface PoolSnapshot {
  readonly config: string;
  readonly creator: string;
  readonly baseMint: string;
  readonly baseReserve: string;
  readonly quoteReserve: string;
  /** SOL per whole token. */
  readonly priceSol: number;
  readonly isMigrated: boolean;
  /** Curve progress to graduation, 0..10000. */
  readonly progressBps: number;
}

export interface ConfigSnapshot {
  readonly feeClaimer: string;
  readonly quoteMint: string;
  readonly creatorTradingFeePercentage: number;
  readonly poolCreationFeeLamports: string;
  readonly migrationQuoteThresholdLamports: string;
  readonly tokenDecimal: number;
}

export interface ConfirmedTx {
  readonly err: unknown;
  readonly feePayer: string;
  readonly accountKeys: readonly string[];
  readonly slot: number;
  readonly blockTime: number | null;
}

export interface FactoryChain {
  readonly cluster: 'devnet' | 'mainnet';
  buildCreatePoolTx(p: {
    config: PublicKey;
    mint: PublicKey;
    wallet: PublicKey;
    name: string;
    symbol: string;
    uri: string;
  }): Promise<Transaction>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  blockHeight(): Promise<number>;
  sendRaw(bytes: Buffer): Promise<string>;
  getConfirmedTransaction(signature: string): Promise<ConfirmedTx | null>;
  getPool(pool: string): Promise<PoolSnapshot | null>;
  getConfig(config: string): Promise<ConfigSnapshot | null>;
}

const n = (v: unknown): string => (v as { toString(): string }).toString();

/**
 * The real chain, over an RPC URL (Helius or any Solana RPC).
 * @param rpcUrl - RPC endpoint.
 * @param cluster - Which cluster it is (recorded on every launch).
 * @returns The chain adapter.
 */
export function createFactoryChain(rpcUrl: string, cluster: 'devnet' | 'mainnet'): FactoryChain {
  const connection = new Connection(rpcUrl, 'confirmed');
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  return {
    cluster,
    async buildCreatePoolTx(p) {
      return client.creator.createPool({
        baseMint: p.mint,
        config: p.config,
        name: p.name,
        symbol: p.symbol,
        uri: p.uri,
        payer: p.wallet,
        poolCreator: p.wallet,
      });
    },
    latestBlockhash: () => connection.getLatestBlockhash('confirmed'),
    blockHeight: () => connection.getBlockHeight('confirmed'),
    sendRaw: (bytes) =>
      connection.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 3 }),
    async getConfirmedTransaction(signature) {
      const t = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!t) return null;
      const keys = t.transaction.message
        .getAccountKeys()
        .staticAccountKeys.map((k) => k.toBase58());
      return {
        err: t.meta?.err ?? null,
        feePayer: keys[0]!,
        accountKeys: keys,
        slot: t.slot,
        blockTime: t.blockTime ?? null,
      };
    },
    async getPool(pool) {
      const p = await client.state.getPool(pool);
      if (!p) return null;
      const s = (p as unknown as { poolState: Record<string, unknown> }).poolState;
      const cfg = await client.state.getPoolConfig(s.config as PublicKey);
      const decimals = Number(
        (cfg as unknown as { tokenDecimal: number } | null)?.tokenDecimal ?? 6,
      );
      let progress = 0;
      try {
        progress = await client.state.getPoolQuoteTokenCurveProgress(pool);
      } catch {
        progress = 0;
      }
      return {
        config: (s.config as PublicKey).toBase58(),
        creator: (s.creator as PublicKey).toBase58(),
        baseMint: (s.baseMint as PublicKey).toBase58(),
        baseReserve: n(s.baseReserve),
        quoteReserve: n(s.quoteReserve),
        priceSol: Number(
          getPriceFromSqrtPrice(
            s.sqrtPrice as Parameters<typeof getPriceFromSqrtPrice>[0],
            decimals,
            9,
          ).toString(),
        ),
        isMigrated: Number(s.isMigrated) === 1 || s.isMigrated === true,
        progressBps: Math.max(0, Math.min(10_000, Math.round(progress * 10_000))),
      };
    },
    async getConfig(config) {
      const c = (await client.state.getPoolConfig(config)) as unknown as Record<
        string,
        unknown
      > | null;
      if (!c) return null;
      return {
        feeClaimer: (c.feeClaimer as PublicKey).toBase58(),
        quoteMint: (c.quoteMint as PublicKey).toBase58(),
        creatorTradingFeePercentage: Number(c.creatorTradingFeePercentage),
        poolCreationFeeLamports: n(c.poolCreationFee),
        migrationQuoteThresholdLamports: n(c.migrationQuoteThreshold),
        tokenDecimal: Number(c.tokenDecimal),
      };
    },
  };
}
