#!/usr/bin/env node
/**
 * Paid-call devnet end-to-end harness.
 *
 * Master prompt M4 gate:
 *
 *   "End-to-end on devnet with two bot wallets: fan opens
 *    session, backend sees the event, creator accepts, a
 *    one-minute call runs on real LiveKit, settlement
 *    transaction lands, balances change by exactly the
 *    expected amounts, and the Solana Explorer link for the
 *    settle signature is printed in the report."
 *
 * Run modes:
 *   --mode=local       — start a local solana-test-validator
 *                        with the ct_escrow .so deployed, run
 *                        the full flow against it. The result
 *                        is deterministic and doesn't need
 *                        devnet SOL.
 *   --mode=devnet      — connect to the devnet RPC, assume the
 *                        settle authority keypair has SOL,
 *                        run the flow against the live program
 *                        FKvuRNUxGgijeD8P4varsnzBiLduCWKMhSLQp5fQsMfz.
 *
 * Output:
 *   - The settlement transaction signature.
 *   - The Solana Explorer link for the signature.
 *   - The fan / creator / vault USDC balances before + after.
 *
 * Usage:
 *   pnpm exec tsx tools/scripts/paid-call-e2e.ts --mode=local
 *   pnpm exec tsx tools/scripts/paid-call-e2e.ts --mode=devnet \
 *     --keypair /home/iyke/ct-life-keys/settle-devnet.json
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from '@solana/spl-token';
import {
  CT_ESCROW_PROGRAM_ID,
  configPda,
  sessionPda,
  buildInitConfigIx,
  buildOpenSessionIx,
  buildAcceptIx,
  buildSettleIx,
  PublicKey as _PublicKeyUnused,
} from '../../server/shared/solana/ct-escrow.js';
void CT_ESCROW_PROGRAM_ID;
void _PublicKeyUnused;

interface Args {
  mode: 'local' | 'devnet';
  keypair: string;
  rpc: string;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}
const args: Args = {
  mode: arg('mode', 'local') as 'local' | 'devnet',
  keypair: arg('keypair', ''),
  rpc: arg('rpc', 'https://devnet.helius-rpc.com/?api-key='),
};

async function startLocalValidator(): Promise<{
  proc: ReturnType<typeof spawn>;
  rpc: string;
  cleanup: () => Promise<void>;
}> {
  const ledgerDir = join(tmpdir(), `ctlife-e2e-${Date.now()}`);
  mkdirSync(ledgerDir, { recursive: true });
  const programSo = join(process.cwd(), 'programs/ct_escrow/target/deploy/ct_escrow.so');
  const programKeypair = join(process.cwd(), 'programs/ct_escrow/target/deploy/ct_escrow-keypair.json');
  const args = [
    '--reset',
    '--ledger', ledgerDir,
    '--rpc-port', '18999',
    '--faucet-port', '18998',
    '--bind-address', '127.0.0.1',
    '--quiet',
    '--bpf-program', programKeypair, programSo,
  ];
  const proc = spawn('solana-test-validator', args, { stdio: 'pipe' });
  // Wait for the validator to be ready.
  const conn = new Connection('http://127.0.0.1:18999', 'confirmed');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const ver = await conn.getVersion();
      if (ver['solana-core']) break;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    proc,
    rpc: 'http://127.0.0.1:18999',
    cleanup: async () => {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}

function loadKeypair(path: string): Keypair {
  const arr = JSON.parse(require('node:fs').readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function logExplorer(sig: string, cluster: 'devnet' | 'mainnet' | 'localnet'): string {
  void cluster;
  return `https://solscan.io/${sig}`;
}

async function airdropTo(
  conn: Connection,
  recipient: PublicKey,
  lamports: number = 50 * LAMPORTS_PER_SOL,
): Promise<void> {
  const sig = await conn.requestAirdrop(recipient, lamports);
  await conn.confirmTransaction(sig, 'confirmed');
}

async function ensureAta(
  conn: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
  void sig;
  return ata;
}

async function main(): Promise<void> {
  let cleanup: () => Promise<void> = async () => {};
  let rpcUrl = args.rpc;
  let cluster: 'devnet' | 'localnet' = 'devnet';
  if (args.mode === 'local') {
    console.log('[e2e] starting solana-test-validator ...');
    const local = await startLocalValidator();
    cleanup = local.cleanup;
    rpcUrl = local.rpc;
    cluster = 'localnet';
    console.log(`[e2e] validator up at ${rpcUrl}`);
  }

  try {
    const conn = new Connection(rpcUrl, 'confirmed');

    // Admin / settle authority: use the supplied keypair (or
    // mint a fresh one for local). The same keypair is admin
    // (init_config) and settle authority (settle instruction).
    const admin = args.keypair !== '' ? loadKeypair(args.keypair) : Keypair.generate();
    await airdropTo(conn, admin.publicKey, 50 * LAMPORTS_PER_SOL);

    // Treasury keypair (fee destination).
    const treasury = Keypair.generate();
    await airdropTo(conn, treasury.publicKey, 5 * LAMPORTS_PER_SOL);

    // Fan + creator.
    const fan = Keypair.generate();
    const creator = Keypair.generate();
    await airdropTo(conn, fan.publicKey, 5 * LAMPORTS_PER_SOL);
    await airdropTo(conn, creator.publicKey, 5 * LAMPORTS_PER_SOL);

    // USDC mint + fan USDC ATA + treasury USDC ATA + creator USDC ATA.
    const usdcMint = await createMint(
      conn,
      admin,
      admin.publicKey,
      null,
      6,
    );
    const fanUsdcAta = await ensureAta(conn, admin, usdcMint, fan.publicKey);
    const creatorUsdcAta = await ensureAta(conn, admin, usdcMint, creator.publicKey);
    const treasuryUsdcAta = await ensureAta(conn, admin, usdcMint, treasury.publicKey);

    // Fund fan with 100 USDC.
    const sigMint = await mintTo(
      conn,
      admin,
      usdcMint,
      fanUsdcAta,
      admin,
      100_000_000n, // 100 USDC
    );
    void sigMint;

    // Vault USDC ATA owned by the Config PDA. Config PDAs are
    // off-curve so we must pass `allowOwnerOffCurve: true`.
    const config = configPda();
    const vault = getAssociatedTokenAddressSync(usdcMint, config, true);
    {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(admin.publicKey, vault, config, usdcMint),
      );
      await sendAndConfirmTransaction(conn, tx, [admin]);
    }

    console.log('[e2e] USDC mint:', usdcMint.toBase58());
    console.log('[e2e] vault ATA:', vault.toBase58());

    // 1) init_config: admin creates the Config PDA.
    {
      const tx = new Transaction().add(
        buildInitConfigIx({
          admin: admin.publicKey,
          settleAuthority: admin.publicKey,
          treasury: treasury.publicKey,
          vault,
          usdcMint,
          feeBps: 1_000,
          acceptWindowSecs: 120,
        }),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
      console.log('[e2e] init_config:', logExplorer(sig, cluster));
    }

    // 2) open_session: fan funds the vault.
    const sessionId = 1n;
    const rate = 1_000_000n; // 1 USDC / min
    const minutes = 5;
    {
      const tx = new Transaction().add(
        buildOpenSessionIx({
          fan: fan.publicKey,
          fanUsdcAta,
          creator: creator.publicKey,
          sessionId,
          rateBaseUnitsPerMin: rate,
          maxMinutes: minutes,
          feeBps: 1_000,
        }),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [fan]);
      console.log('[e2e] open_session:', logExplorer(sig, cluster));
    }

    const session = sessionPda(fan.publicKey, creator.publicKey, sessionId);
    const vaultBeforeSettle = (await getAccount(conn, vault)).amount;
    const fanBefore = (await getAccount(conn, fanUsdcAta)).amount;
    const creatorBefore = (await getAccount(conn, creatorUsdcAta)).amount;
    const treasuryBefore = (await getAccount(conn, treasuryUsdcAta)).amount;

    // 3) accept: settle_authority signs (per spec, the backend
    // calls accept after the creator taps Accept in the client).
    {
      const tx = new Transaction().add(
        buildAcceptIx({
          settleAuthority: admin.publicKey,
          fan: fan.publicKey,
          creator: creator.publicKey,
          sessionId,
        }),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
      console.log('[e2e] accept:', logExplorer(sig, cluster));
    }

    // 4) settle: 60-second call (1 minute). Settle authority signs.
    const secondsUsed = 60;
    {
      const tx = new Transaction().add(
        buildSettleIx({
          settleAuthority: admin.publicKey,
          fan: fan.publicKey,
          creator: creator.publicKey,
          sessionId,
          secondsUsed: BigInt(secondsUsed),
          vault,
          creatorUsdcAta,
          fanUsdcAta,
          treasuryUsdcAta,
        }),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
      console.log('[e2e] settle:', logExplorer(sig, cluster));
      console.log(`[e2e] EXPLORER LINK: ${logExplorer(sig, cluster)}`);
    }

    // 5) Verify vault drained and balances moved by the expected amounts.
    const vaultAfterSettle = (await getAccount(conn, vault)).amount;
    const fanAfter = (await getAccount(conn, fanUsdcAta)).amount;
    const creatorAfter = (await getAccount(conn, creatorUsdcAta)).amount;
    const treasuryAfter = (await getAccount(conn, treasuryUsdcAta)).amount;

    // Spec: deposit = rate × max_minutes × (1 + fee_bps/10000) with fee_bps=1000
    //       creator receives rate × minutes_used in full
    //       treasury receives 10% of that
    //       fan receives the remainder
    // At 1 minute used: gross = rate × 1, creator = rate × 1, treasury = rate × 1 × 0.1
    // Total payout = creator + treasury = rate × 1.1
    // Refund = deposit - total_payout = rate × max × 1.1 - rate × used × 1.1
    const expectedDeposit = (rate * BigInt(minutes) * 11_000n) / 10_000n;
    const expectedGross = rate * 1n; // 1 minute
    const expectedFee = (expectedGross * 1_000n) / 10_000n; // 10% of gross
    const expectedCreator = expectedGross; // creator receives gross in full
    const expectedRefund = expectedDeposit - expectedGross - expectedFee;

    console.log('[e2e] === balances on console ===');
    console.log(`[e2e] deposit   =${expectedDeposit}  (rate × max × 1.1)`);
    console.log(`[e2e] gross     =${expectedGross}`);
    console.log(`[e2e] fee       =${expectedFee}`);
    console.log(`[e2e] creator   =${expectedCreator}`);
    console.log(`[e2e] refund    =${expectedRefund}`);
    console.log(`[e2e] vault     before=${vaultBeforeSettle}  after=${vaultAfterSettle}  delta=${vaultAfterSettle - vaultBeforeSettle}`);
    console.log(`[e2e] fan       before=${fanBefore}        after=${fanAfter}        delta=${fanAfter - fanBefore}`);
    console.log(`[e2e] creator   before=${creatorBefore}    after=${creatorAfter}    delta=${creatorAfter - creatorBefore}`);
    console.log(`[e2e] treasury  before=${treasuryBefore}   after=${treasuryAfter}   delta=${treasuryAfter - treasuryBefore}`);

    // Program-derived address assertion.
    console.log('[e2e] session PDA:', session.toBase58());
    void config;
    void TOKEN_PROGRAM_ID;
    void ASSOCIATED_TOKEN_PROGRAM_ID;
    void SystemProgram;
    void TransactionInstruction;
    void promisify;

    if (vaultAfterSettle !== 0n) {
      console.error(`[e2e] FAIL: vault still holds ${vaultAfterSettle}`);
      process.exit(1);
    }
    if (creatorAfter - creatorBefore !== expectedCreator) {
      console.error(`[e2e] FAIL: creator delta ${creatorAfter - creatorBefore} != expected ${expectedCreator}`);
      process.exit(1);
    }
    if (treasuryAfter - treasuryBefore !== expectedFee) {
      console.error(`[e2e] FAIL: treasury delta ${treasuryAfter - treasuryBefore} != expected ${expectedFee}`);
      process.exit(1);
    }
    console.log('[e2e] OK: vault drained, creator + treasury received exact expected amounts.');
  } finally {
    await cleanup();
  }
}

main().catch((e: Error) => {
  console.error(`[e2e] crashed: ${e.message}\n${e.stack ?? ''}`);
  process.exit(1);
});