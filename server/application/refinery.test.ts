/**
 * ORE board read path (GitHub #5).
 *
 * Hosted GET /v1/ore/board answered a bare 500 because the reader was
 * off and nothing was cached. Pins: reader off outside local is a 503
 * SERVER_BUSY {reason: 'ore_reader'}; reader on decodes the mainnet
 * accounts into the contract shape and caches them; an RPC failure
 * serves the last good board, or a 503 when there is none.
 *
 * The RPC is a stubbed fetch replaying the mainnet fixture. Uses the
 * dev Redis.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { createRedis } from '../shared/redis/client.js';
import { ServerBusyError } from '../shared/domain/errors.js';
import { BOARD_PDA, TREASURY_PDA } from '../shared/solana/ore-board.js';
import { readBoard, oreReaderAvailable } from './refinery.js';
import type { AppContext } from './context.js';

loadDotenv({ path: process.cwd() + '/.env' });

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'server/shared/solana/fixtures/ore-mainnet.json'), 'utf8'),
) as { slot: number; board: string; treasury: string; round: string; roundAddress: string };

const redis = createRedis();
const KEYS = ['ore:board', 'ore:board:last', 'ore:board:rl'];
const savedEnv = process.env.APP_ENV;

function ctxWith(oreReader: boolean): AppContext {
  return {
    config: {
      features: { oreReader },
      helius: { rpcUrlMainnet: 'https://mainnet.test' },
    },
    redis,
    configCache: { loadOptional: () => ({ boardCacheSec: 2, maxRoundAgeSec: 600 }) },
  } as unknown as AppContext;
}

/** A fetch that answers like a mainnet RPC holding the fixture accounts. */
function mainnetFetch(): typeof fetch {
  return vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params: [unknown] };
    const acc = (b64: string): { data: [string, string] } => ({ data: [b64, 'base64'] });
    if (req.method === 'getMultipleAccounts') {
      expect(req.params[0]).toEqual([BOARD_PDA.toBase58(), TREASURY_PDA.toBase58()]);
      return Response.json({
        result: {
          context: { slot: fixture.slot },
          value: [acc(fixture.board), acc(fixture.treasury)],
        },
      });
    }
    expect(req.params[0]).toBe(fixture.roundAddress);
    return Response.json({
      result: { context: { slot: fixture.slot }, value: acc(fixture.round) },
    });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await redis.main.del(...KEYS);
  process.env.APP_ENV = 'staging';
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.APP_ENV = savedEnv;
});

afterAll(async () => {
  await redis.main.del(...KEYS);
  await redis.close();
});

describe('readBoard', () => {
  it('answers 503 SERVER_BUSY ore_reader when the reader is off outside local', async () => {
    const err = await readBoard(ctxWith(false)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerBusyError);
    expect((err as ServerBusyError).httpStatus).toBe(503);
    expect((err as ServerBusyError).details).toMatchObject({ reason: 'ore_reader' });
    expect(oreReaderAvailable(ctxWith(false))).toBe(false);
  });

  it('serves a 25-square dev board in local when the reader is off', async () => {
    process.env.APP_ENV = 'local';
    const board = await readBoard(ctxWith(false));
    expect(board.squares).toHaveLength(25);
    expect(oreReaderAvailable(ctxWith(false))).toBe(true);
  });

  it('decodes the live mainnet board into the contract shape and caches it', async () => {
    const f = mainnetFetch();
    vi.stubGlobal('fetch', f);
    const board = await readBoard(ctxWith(true));
    expect(board.roundId).toBe(435296);
    expect(board.endsAtSlot).toBe(455383422);
    expect(typeof board.endsAt).toBe('string');
    expect(board.squares).toHaveLength(25);
    expect(board.squares[0]).toEqual({ deployedLamports: '237863785' });
    expect(board.motherlodeOre).toBe('17880000000000');
    expect(board).toMatchObject({ cityStakedOre: '0', priceUsd: '0' });

    // A second read inside boardCacheSec is the cached board: no RPC.
    expect(await readBoard(ctxWith(true))).toEqual(board);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('serves the last good board when the RPC fails', async () => {
    vi.stubGlobal('fetch', mainnetFetch());
    const good = await readBoard(ctxWith(true));
    await redis.main.del('ore:board', 'ore:board:rl');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 502 })),
    );
    expect(await readBoard(ctxWith(true))).toEqual(good);
  });

  it('answers 503 when the RPC fails and nothing was ever read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 502 })),
    );
    const err = await readBoard(ctxWith(true)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerBusyError);
  });
});
