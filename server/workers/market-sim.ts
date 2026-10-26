/**
 * Market simulation: keeps the Terminal Cafe market alive.
 *
 *   - Ticks every live coin through the MarketEngine (price, mcap,
 *     graduation, death) every `tickLengthSec`.
 *   - Launches a house coin every `launchIntervalSec` while fewer than
 *     `maxActiveCoins` are alive, and one at boot when the market is
 *     empty. A Redis lock makes one replica the launcher per interval.
 *   - Picks up coins players launch through POST /v1/market/launchpad.
 *   - Announces deaths as `evt_rug` to the city.
 *
 * All values come from contract/config/market.json.
 */
import type { Logger } from 'pino';
import { launchCoin } from '../application/launchpad.js';
import { MarketEngine, type MarketConfig } from '../application/market-engine.js';
import { publishWorldEvent } from '../application/realtime-bus.js';
import { cardCoinRug } from '../application/city-cards.js';
import type { AppContext } from '../application/context.js';
import { ValidationFailedError } from '../shared/domain/errors.js';

type SimConfig = MarketConfig & { readonly launchIntervalSec: number };

const LAUNCH_LOCK_KEY = 'market:launch:lock';
/** How often coins launched by players are looked for (a Factory coin ticks within this). */
const SYNC_INTERVAL_MS = 5_000;
const TICKER_TRIES = 5;

const NAME_HEADS = [
  'Moon',
  'Doge',
  'Pepe',
  'Giga',
  'Based',
  'Turbo',
  'Wif',
  'Chad',
  'Bonk',
  'Cope',
];
const NAME_TAILS = ['Cat', 'Inu', 'Frog', 'Coin', 'AI', 'Hat', 'Pump', 'Fi', 'Labs', 'Rocket'];

/**
 * A parody coin name and ticker, e.g. "Turbo Frog" / "TURFRO".
 * @param rand - Uniform [0, 1) source.
 */
export function houseCoinName(rand: () => number = Math.random): { name: string; ticker: string } {
  const head = NAME_HEADS[Math.floor(rand() * NAME_HEADS.length)]!;
  const tail = NAME_TAILS[Math.floor(rand() * NAME_TAILS.length)]!;
  const ticker = `${head.slice(0, 3)}${tail.slice(0, 3)}`.toUpperCase().slice(0, 6);
  return { name: `${head} ${tail}`, ticker };
}

async function liveCoinIds(ctx: AppContext): Promise<string[]> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ coin_id: string }>(`SELECT coin_id FROM coins WHERE stage <> 'dead'`),
  );
  return r.rows.map((row) => row.coin_id);
}

/**
 * Launch one house coin if the market has room. Returns the coin id,
 * or null when at the cap or another replica holds this interval.
 */
export async function launchIfRoom(ctx: AppContext, cfg: SimConfig): Promise<string | null> {
  const lock = await ctx.redis.main.set(
    LAUNCH_LOCK_KEY,
    '1',
    'EX',
    Math.max(1, cfg.launchIntervalSec - 1),
    'NX',
  );
  if (lock !== 'OK') return null;
  if ((await liveCoinIds(ctx)).length >= cfg.maxActiveCoins) return null;
  for (let i = 0; i < TICKER_TRIES; i++) {
    const { name, ticker } = houseCoinName();
    // Repeat names get a digit so the ticker stays unique.
    const t = i === 0 ? ticker : `${ticker.slice(0, 5)}${i}`;
    try {
      return (await launchCoin(ctx, { userId: 'house', name, ticker: t })).coinId;
    } catch (e) {
      if (!(e instanceof ValidationFailedError)) throw e;
    }
  }
  return null;
}

/**
 * Start the market simulation.
 * @returns A stop function.
 */
export async function startMarketSim(ctx: AppContext, log: Logger): Promise<() => void> {
  const cfg = ctx.configCache.load<SimConfig>('market');
  const engine = new MarketEngine(cfg, {
    db: ctx.db,
    redis: ctx.redis.main,
    onDead: async (coin) => {
      log.info({ coinId: coin.coinId, ticker: coin.ticker }, 'coin died');
      await publishWorldEvent(ctx, 'evt_rug', { coinId: coin.coinId, ticker: coin.ticker });
      await cardCoinRug(ctx, { coinId: coin.coinId, ticker: coin.ticker, reason: 'dead' });
    },
  });
  for (const id of await liveCoinIds(ctx)) await engine.track(id);
  const stopEngine = engine.start();

  const launch = async (): Promise<void> => {
    const id = await launchIfRoom(ctx, cfg);
    if (id !== null) {
      await engine.track(id);
      log.info({ coinId: id }, 'house coin launched');
    }
  };
  const sync = async (): Promise<void> => {
    for (const id of await liveCoinIds(ctx)) await engine.track(id);
  };
  const onError = (what: string) => (e: unknown) =>
    log.error({ err: (e as Error).message }, `market ${what} failed`);

  if (engine.size() === 0) await launch().catch(onError('launch'));
  const launchTimer = setInterval(
    () => void launch().catch(onError('launch')),
    cfg.launchIntervalSec * 1000,
  );
  const syncTimer = setInterval(() => void sync().catch(onError('sync')), SYNC_INTERVAL_MS);
  log.info(
    { coins: engine.size(), launchIntervalSec: cfg.launchIntervalSec },
    'market sim running',
  );

  return () => {
    clearInterval(launchTimer);
    clearInterval(syncTimer);
    stopEngine();
  };
}
