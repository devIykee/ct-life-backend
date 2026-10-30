/**
 * Prediction Pit tuning, loaded once from contract/config/predictions.json
 * (schema: predictions.schema.json, explained in docs/PREDICTIONS.md).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export type Horizon = '5m' | '15m' | '1h' | 'daily';

/** Length of each horizon. `daily` markets last `crypto.horizonSec` (24 h). */
export const HORIZON_SEC: Record<Exclude<Horizon, 'daily'>, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
};

const Cadence = z.object({
  everySec: z.number().int().min(60),
  betWindowSec: z.number().int().min(30),
});

const PredictionsFile = z.object({
  version: z.string(),
  payoutBps: z.number().int().min(10_001).max(100_000),
  minStakeCents: z.number().int().positive(),
  maxStakeCents: z.number().int().positive(),
  dailyStakeCapCents: z.number().int().positive(),
  sim: z.object({
    topCoins: z.number().int().min(0).max(10),
    horizons: z.array(Cadence.extend({ horizon: z.enum(['5m', '15m', '1h']) })),
  }),
  event: Cadence.extend({
    horizon: z.literal('1h'),
    questions: z.array(z.enum(['event_rug_1h'])).max(1),
  }),
  crypto: Cadence.extend({
    symbols: z.array(z.string().regex(/^[A-Z0-9]{5,20}$/)),
    horizonSec: z.number().int().min(3600),
  }),
  resolveGraceSec: z.number().int().min(60),
  pruneAfterDays: z.number().int().min(1),
});

export type PredictionsConfig = z.infer<typeof PredictionsFile>;

let cached: PredictionsConfig | null = null;

/**
 * The parsed predictions.json (read once per process).
 * @returns The config.
 */
export function predictionsConfig(): PredictionsConfig {
  cached ??= PredictionsFile.parse(
    JSON.parse(readFileSync(join(process.cwd(), 'contract/config/predictions.json'), 'utf8')),
  );
  return cached;
}
