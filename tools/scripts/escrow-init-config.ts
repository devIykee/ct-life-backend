/**
 * ONE-TIME ADMIN SCRIPT (unlock C2): initialize the ct_escrow Config PDA on DEVNET.
 *
 * Run by the operator on their own machine, with their own keys. The API never runs
 * this and never holds the admin key. It does three things in one transaction:
 *   1. create the Config PDA's USDC token account (init_config wants it to exist),
 *   2. create the treasury's USDC token account (settle pays the fee there),
 *   3. init_config(fee_bps, accept_window_secs) with the admin paying and the settle
 *      authority co-signing (it is written into the Config and checked by accept,
 *      settle and refund).
 *
 * It is a DRY RUN unless you pass --send. Read-only preflight first, and it refuses:
 *   - unless the RPC's genesis hash is devnet's,
 *   - if the deployed ct_escrow is the old build (commit 2afe8fc: creator-signed accept,
 *     no settle-authority check). Upgrade the program from the current lib.rs first
 *     (docs/ONCHAIN.md "Paid-call escrow on devnet"),
 *   - if the Config already exists (prints it instead),
 *   - if the admin has under 0.02 SOL.
 *
 * Usage:
 *   pnpm exec tsx tools/scripts/escrow-init-config.ts \
 *     --admin ~/keys/escrow-admin-devnet.json \
 *     --settle-authority ~/keys/settle-devnet.json \   # = SETTLE_AUTHORITY_KEYPAIR_DEVNET
 *     --treasury <TREASURY_PUBKEY_DEVNET> \
 *     [--rpc https://api.devnet.solana.com] [--fee-bps 1000] [--accept-window 120] [--send]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  CT_ESCROW_PROGRAM_ID,
  buildInitConfigIx,
  configPda,
  decodeEscrowConfig,
} from '../../server/shared/solana/ct-escrow.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DEVNET_USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
/** An error message only the current lib.rs build contains (errors.rs Unauthorized). */
const CURRENT_BUILD_MARKER = 'Caller is not authorized (settle_authority or fan)';
/** An error message only the old devnet build (2afe8fc) contains. */
const OLD_BUILD_MARKER = 'Caller is not the session creator';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i < 0 ? undefined : process.argv[i + 1];
  if (v !== undefined && !v.startsWith('--')) return v;
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(2);
}

function keypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path.replace(/^~/, homedir()), 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

function fail(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const send = process.argv.includes('--send');
  const rpc = arg('rpc', 'https://api.devnet.solana.com');
  const admin = keypair(arg('admin'));
  const settle = keypair(arg('settle-authority'));
  const treasury = new PublicKey(arg('treasury'));
  const feeBps = Number(arg('fee-bps', '1000'));
  const acceptWindowSecs = Number(arg('accept-window', '120'));
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) fail('--fee-bps 0..10000');
  if (!Number.isInteger(acceptWindowSecs) || acceptWindowSecs < 30) fail('--accept-window >= 30');
  const conn = new Connection(rpc, 'confirmed');

  // 1. Devnet only.
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) fail(`RPC ${rpc} is not devnet (genesis ${genesis})`);

  // 2. The deployed program must be the current lib.rs build.
  const program = await conn.getAccountInfo(CT_ESCROW_PROGRAM_ID);
  if (!program?.executable) fail(`program ${CT_ESCROW_PROGRAM_ID.toBase58()} is not deployed`);
  const programData = new PublicKey(program.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData);
  const bin = pd?.data ?? Buffer.alloc(0);
  if (bin.includes(Buffer.from(OLD_BUILD_MARKER))) {
    fail(
      'the deployed ct_escrow is the OLD build (commit 2afe8fc). Upgrade it from the current ' +
        'programs/ct_escrow source first (docs/ONCHAIN.md "Paid-call escrow on devnet").',
    );
  }
  if (!bin.includes(Buffer.from(CURRENT_BUILD_MARKER))) {
    fail('the deployed ct_escrow is not a build of the current lib.rs (marker string missing)');
  }

  // 3. Not initialized yet.
  const config = configPda();
  const existing = await conn.getAccountInfo(config);
  if (existing) {
    console.log('Config already exists:', decodeEscrowConfig(existing.data) ?? '(unknown layout)');
    return;
  }

  // 4. The admin pays rent for the Config and two token accounts.
  const lamports = await conn.getBalance(admin.publicKey);
  if (lamports < 20_000_000) fail(`admin ${admin.publicKey.toBase58()} has under 0.02 SOL`);

  const configVault = getAssociatedTokenAddressSync(DEVNET_USDC, config, true);
  const treasuryAta = getAssociatedTokenAddressSync(DEVNET_USDC, treasury);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      configVault,
      config,
      DEVNET_USDC,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      treasuryAta,
      treasury,
      DEVNET_USDC,
    ),
    buildInitConfigIx({
      admin: admin.publicKey,
      settleAuthority: settle.publicKey,
      treasury,
      usdcMint: DEVNET_USDC,
      vault: configVault,
      feeBps,
      acceptWindowSecs,
    }),
  );

  console.log('ct_escrow init_config on DEVNET');
  console.log('  program          ', CT_ESCROW_PROGRAM_ID.toBase58());
  console.log('  config PDA       ', config.toBase58());
  console.log('  config USDC ATA  ', configVault.toBase58());
  console.log('  admin (payer)    ', admin.publicKey.toBase58());
  console.log('  settle authority ', settle.publicKey.toBase58(), '(must equal the API key)');
  console.log('  treasury         ', treasury.toBase58(), 'ATA', treasuryAta.toBase58());
  console.log('  usdc mint        ', DEVNET_USDC.toBase58());
  console.log('  fee_bps          ', feeBps, ' accept_window_secs', acceptWindowSecs);

  if (!send) {
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(admin, settle);
    const sim = await conn.simulateTransaction(tx);
    console.log('DRY RUN (simulation):', sim.value.err ?? 'ok');
    for (const line of sim.value.logs ?? []) console.log('   ', line);
    console.log('Nothing was sent. Re-run with --send to initialize.');
    return;
  }
  const sig = await sendAndConfirmTransaction(conn, tx, [admin, settle], {
    commitment: 'confirmed',
  });
  console.log('init_config sent:', `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  const after = await conn.getAccountInfo(config);
  console.log('Config:', after ? decodeEscrowConfig(after.data) : '(not found yet)');
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
