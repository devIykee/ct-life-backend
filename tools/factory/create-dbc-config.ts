/**
 * Create CT Life's Meteora DBC partner config (once per cluster).
 *
 * The config is the launch template every player token uses: curve, fees,
 * migration to DAMM v2, LP split and the fee claimer. Its PUBLIC address then
 * goes in the API env as FACTORY_DBC_CONFIG. Run it by hand; the payer
 * keypair file is read from disk and never stored or logged.
 *
 *   pnpm exec tsx tools/factory/create-dbc-config.ts --rpc https://api.devnet.solana.com \
 *     --payer ./throwaway-devnet.json --fee-claimer <PARTNER_FEE_WALLET> [--dry-run]
 *
 * Defaults (user decision 2026-10-26; override with flags):
 *   --fee-bps 100              1% trading fee (Meteora takes 20% of it)
 *   --creator-share 50         creator share of the other 80% (partner gets the rest)
 *   --creation-fee-sol 0       pool creation fee charged to the launcher
 *   --initial-mcap-sol 25      starting market cap, in SOL
 *   --migration-mcap-sol 400   market cap at graduation to DAMM v2, in SOL
 *   LP after graduation: 50% partner + 50% creator, all permanently locked.
 *   Token: SPL, 6 decimals, 1,000,000,000 supply, immutable metadata.
 */
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  ActivationType,
  BaseFeeMode,
  buildCurveWithMarketCap,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i < 0 ? undefined : process.argv[i + 1];
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  return v;
}

const rpc = arg('rpc');
const feeClaimer = new PublicKey(arg('fee-claimer'));
const feeBps = Number(arg('fee-bps', '100'));
const creatorShare = Number(arg('creator-share', '50'));
const creationFeeSol = Number(arg('creation-fee-sol', '0'));
const initialMcap = Number(arg('initial-mcap-sol', '25'));
const migrationMcap = Number(arg('migration-mcap-sol', '400'));
const dryRun = process.argv.includes('--dry-run');

const curve = buildCurveWithMarketCap({
  token: {
    tokenType: TokenType.SPLToken,
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.NINE,
    tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: 1_000_000_000,
    leftover: 0,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: {
        startingFeeBps: feeBps,
        endingFeeBps: feeBps,
        numberOfPeriod: 0,
        totalDuration: 0,
      },
    },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: creatorShare,
    poolCreationFee: creationFeeSol,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.FixedBps100,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  },
  liquidityDistribution: {
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 50,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 50,
  },
  lockedVesting: {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },
  activationType: ActivationType.Timestamp,
  initialMarketCap: initialMcap,
  migrationMarketCap: migrationMcap,
});

console.info('DBC config parameters:', {
  rpc,
  feeClaimer: feeClaimer.toBase58(),
  feeBps,
  creatorShare,
  creationFeeSol,
  initialMcap,
  migrationMcap,
});
if (dryRun) process.exit(0);

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(arg('payer'), 'utf8')) as number[]),
);
const connection = new Connection(rpc, 'confirmed');
const client = new DynamicBondingCurveClient(connection, 'confirmed');
const config = Keypair.generate();
const tx = await client.partner.createConfig2({
  config: config.publicKey,
  feeClaimer,
  leftoverReceiver: feeClaimer,
  quoteMint: WSOL,
  payer: payer.publicKey,
  ...curve,
});
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.sign(payer, config);
const sig = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction(sig, 'confirmed');
console.info(`FACTORY_DBC_CONFIG=${config.publicKey.toBase58()}`);
console.info(`signature ${sig}`);
