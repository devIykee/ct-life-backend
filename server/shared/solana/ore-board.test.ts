/**
 * ORE board decoder tests.
 *
 * `fixtures/ore-mainnet.json` holds the Board, Treasury and current
 * Round accounts read from mainnet on 2026-10-10, so these tests pin
 * the decoder to the real on-chain layout, not to our reading of it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeBoard,
  decodeRound,
  decodeTreasuryMotherlode,
  OreDecodeError,
  roundPda,
  toLiveBoard,
} from './ore-board.js';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'ore-mainnet.json'), 'utf8'),
) as { slot: number; board: string; treasury: string; round: string; roundAddress: string };
const buf = (b64: string): Buffer => Buffer.from(b64, 'base64');

describe('ORE board decoder (mainnet fixture)', () => {
  const board = decodeBoard(buf(fixture.board));
  const round = decodeRound(buf(fixture.round));

  it('decodes the Board singleton', () => {
    expect(board).toEqual({ roundId: 435296n, startSlot: 455383182n, endSlot: 455383422n });
  });

  it('derives the Round PDA the chain uses for that round', () => {
    expect(roundPda(board.roundId).toBase58()).toBe(fixture.roundAddress);
  });

  it('decodes the 25 deployed squares of the current round', () => {
    expect(round.id).toBe(board.roundId);
    expect(round.deployed).toHaveLength(25);
    expect(round.deployed.slice(0, 3)).toEqual([237863785n, 237319858n, 229979390n]);
  });

  it('decodes the motherlode pool from the Treasury', () => {
    expect(decodeTreasuryMotherlode(buf(fixture.treasury))).toBe(17_880_000_000_000n);
  });

  it('builds the contract board with endsAt from the remaining slots', () => {
    const now = Date.UTC(2026, 9, 10, 20, 0, 0);
    const live = toLiveBoard(board, round, 17_880_000_000_000n, fixture.slot, now);
    expect(live.roundId).toBe(435296);
    expect(live.endsAtSlot).toBe(455383422);
    expect(live.endsAt).toBe(new Date(now + (455383422 - fixture.slot) * 400).toISOString());
    expect(live.squares).toHaveLength(25);
    expect(live.squares[0]).toEqual({ deployedLamports: '237863785' });
    expect(live.motherlodeOre).toBe('17880000000000');
  });
});

describe('ORE board decoder guards', () => {
  it('rejects an account with the wrong discriminator', () => {
    expect(() => decodeBoard(buf(fixture.treasury))).toThrow(OreDecodeError);
    expect(() => decodeRound(buf(fixture.board))).toThrow(OreDecodeError);
  });

  it('rejects a Round that is not the board round', () => {
    const board = decodeBoard(buf(fixture.board));
    const round = { ...decodeRound(buf(fixture.round)), id: board.roundId - 1n };
    expect(() => toLiveBoard(board, round, 0n, fixture.slot, 0)).toThrow(/does not match/);
  });

  it('reports no end while a round waits for its first deploy (end_slot = u64::MAX)', () => {
    const board = { ...decodeBoard(buf(fixture.board)), endSlot: 0xffff_ffff_ffff_ffffn };
    const live = toLiveBoard(board, decodeRound(buf(fixture.round)), 0n, fixture.slot, 1_000);
    expect(live.endsAtSlot).toBe(0);
    expect(live.endsAt).toBe(new Date(1_000).toISOString());
  });
});
