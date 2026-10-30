/**
 * The ct_escrow instruction builders must pass accounts in the order of the Accounts
 * structs in programs/ct_escrow/.../lib.rs (Anchor reads them positionally). These
 * tests read the Rust source and compare, then check the account decoders and the
 * settle split against the program's math.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_DISCRIMINATORS,
  buildAcceptIx,
  buildInitConfigIx,
  buildOpenSessionIx,
  buildRefundIx,
  buildSettleIx,
  computeDeposit,
  configPda,
  decodeEscrowConfig,
  decodeEscrowSession,
  sessionPda,
  sessionVault,
  settlementSplit,
} from './ct-escrow.js';

const LIB = readFileSync('programs/ct_escrow/programs/ct_escrow/src/lib.rs', 'utf8');

/** Field names of `pub struct <name><'info> { ... }` in lib.rs, in order. */
function accountsOf(name: string): string[] {
  const start = LIB.indexOf(`pub struct ${name}<'info>`);
  expect(start, name).toBeGreaterThan(0);
  const body = LIB.slice(start, LIB.indexOf('\n}\n', start));
  return [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) => m[1]!);
}

const k = (): PublicKey => Keypair.generate().publicKey;
const fan = k();
const creator = k();
const usdcMint = k();
const sessionId = 42n;
const session = sessionPda(fan, creator, sessionId);
const vault = sessionVault(session, usdcMint);

describe('builders follow lib.rs account order', () => {
  it('open_session', () => {
    const ix = buildOpenSessionIx({
      fan,
      fanUsdcAta: k(),
      creator,
      usdcMint,
      sessionId,
      rateBaseUnitsPerMin: 500_000n,
      maxMinutes: 5,
      feeBps: 1000,
    });
    const names = accountsOf('OpenSession');
    expect(names).toEqual([
      'session',
      'config',
      'vault',
      'usdc_mint',
      'fan_usdc_ata',
      'creator',
      'fan',
      'token_program',
      'associated_token_program',
      'system_program',
      'rent',
    ]);
    expect(ix.keys).toHaveLength(names.length);
    expect(ix.keys[0]!.pubkey.equals(session)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(configPda())).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(vault)).toBe(true);
    expect(ix.keys[3]!.pubkey.equals(usdcMint)).toBe(true);
    expect(ix.keys[5]!.pubkey.equals(creator)).toBe(true);
    expect(ix.keys[6]).toMatchObject({ isSigner: true, isWritable: true });
    expect(ix.keys[6]!.pubkey.equals(fan)).toBe(true);
    // disc(8) + session_id u64 + rate u64 + max_minutes u16
    expect(ix.data.length).toBe(8 + 8 + 8 + 2);
  });

  it('accept, settle, refund and init_config', () => {
    const authority = k();
    const accept = buildAcceptIx({ settleAuthority: authority, fan, creator, sessionId });
    expect(accept.keys).toHaveLength(accountsOf('Accept').length);
    expect(accept.keys[2]).toMatchObject({ isSigner: true });

    const settle = buildSettleIx({
      settleAuthority: authority,
      fan,
      creator,
      sessionId,
      secondsUsed: 61n,
      vault,
      usdcMint,
      creatorUsdcAta: k(),
      fanUsdcAta: k(),
      treasuryUsdcAta: k(),
    });
    const sNames = accountsOf('Settle');
    expect(settle.keys).toHaveLength(sNames.length);
    expect(settle.keys[sNames.indexOf('usdc_mint')]!.pubkey.equals(usdcMint)).toBe(true);
    expect(settle.keys[sNames.indexOf('vault')]!.pubkey.equals(vault)).toBe(true);
    expect(settle.keys[sNames.indexOf('settle_authority')]).toMatchObject({ isSigner: true });
    expect(settle.keys[sNames.indexOf('fan')]!.pubkey.equals(fan)).toBe(true);

    const refund = buildRefundIx({
      fan,
      creator,
      sessionId,
      vault,
      usdcMint,
      fanUsdcAta: k(),
      signer: authority,
    });
    const rNames = accountsOf('Refund');
    expect(refund.keys).toHaveLength(rNames.length);
    expect(refund.keys[rNames.indexOf('usdc_mint')]!.pubkey.equals(usdcMint)).toBe(true);
    expect(refund.keys[rNames.indexOf('signer')]).toMatchObject({ isSigner: true });

    const init = buildInitConfigIx({
      admin: k(),
      settleAuthority: authority,
      treasury: k(),
      usdcMint,
      vault: k(),
      feeBps: 1000,
      acceptWindowSecs: 120,
    });
    const iNames = accountsOf('InitConfig');
    expect(init.keys).toHaveLength(iNames.length);
    expect(init.keys[iNames.indexOf('settle_authority')]).toMatchObject({ isSigner: true });
    expect(init.keys[iNames.indexOf('admin')]).toMatchObject({ isSigner: true, isWritable: true });
  });
});

describe('account decoders', () => {
  it('decode a current-layout Config and refuse the old 107-byte one', () => {
    const keys = [k(), k(), k(), k(), k()];
    const data = new Uint8Array(8 + 160 + 7);
    data.set(ACCOUNT_DISCRIMINATORS.config, 0);
    keys.forEach((p, i) => data.set(p.toBytes(), 8 + i * 32));
    const dv = new DataView(data.buffer);
    dv.setUint16(168, 1000, true);
    dv.setUint32(170, 120, true);
    expect(decodeEscrowConfig(data)).toEqual({
      admin: keys[0]!.toBase58(),
      settleAuthority: keys[1]!.toBase58(),
      treasury: keys[2]!.toBase58(),
      usdcMint: keys[3]!.toBase58(),
      vault: keys[4]!.toBase58(),
      feeBps: 1000,
      acceptWindowSecs: 120,
    });
    const old = new Uint8Array(107);
    old.set(ACCOUNT_DISCRIMINATORS.config, 0);
    expect(decodeEscrowConfig(old)).toBeNull();
  });

  it('decode a Session', () => {
    const data = new Uint8Array(127);
    const dv = new DataView(data.buffer);
    data.set(ACCOUNT_DISCRIMINATORS.session, 0);
    dv.setBigUint64(8, sessionId, true);
    data.set(fan.toBytes(), 16);
    data.set(creator.toBytes(), 48);
    dv.setBigUint64(80, 500_000n, true);
    dv.setUint16(88, 5, true);
    dv.setBigUint64(90, 2_750_000n, true);
    dv.setUint16(98, 1000, true);
    dv.setBigInt64(100, 1_700_000_000n, true);
    data[124] = 1;
    expect(decodeEscrowSession(data)).toMatchObject({
      sessionId,
      fan: fan.toBase58(),
      creator: creator.toBase58(),
      ratePerMin: 500_000n,
      maxMinutes: 5,
      deposit: 2_750_000n,
      feeBps: 1000,
      openedAt: 1_700_000_000n,
      status: 1,
    });
  });
});

describe('settlement split (lib.rs settle)', () => {
  const base = { ratePerMin: 500_000n, maxMinutes: 5, feeBps: 1000 };
  const deposit = computeDeposit(500_000n, 5, 1000);

  it('deposit is rate x minutes x (1 + fee)', () => {
    expect(deposit).toBe(2_750_000n);
  });

  it('rounds minutes up, caps at the booking, fee on top, rest back to the fan', () => {
    expect(settlementSplit({ ...base, deposit, secondsUsed: 0n })).toEqual({
      minutes: 0n,
      creatorAmount: 0n,
      fee: 0n,
      refund: 2_750_000n,
    });
    expect(settlementSplit({ ...base, deposit, secondsUsed: 61n })).toEqual({
      minutes: 2n,
      creatorAmount: 1_000_000n,
      fee: 100_000n,
      refund: 1_650_000n,
    });
    expect(settlementSplit({ ...base, deposit, secondsUsed: 99_999n })).toEqual({
      minutes: 5n,
      creatorAmount: 2_500_000n,
      fee: 250_000n,
      refund: 0n,
    });
  });
});
