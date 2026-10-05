/**
 * Gigs service (M5 #63).
 *
 * Endpoints:
 *
 *   GET  /v1/gigs             — list the 5 side gigs with formulas
 *   POST /v1/gigs/{gigId}/run — run a gig; resolves pay via the
 *                                formula, credits via a 'gig_pay'
 *                                ledger row, writes a gig_runs row.
 *
 * The five side gigs:
 *
 *   food_delivery       : tip 5..50 cents per km; base 300
 *   data_entry          : flat 200 + 50 per correct row (1..10)
 *   dog_walking         : flat 500 + 200 per 30-min block
 *   ad_clicks           : 100 base + 5 per click (1..50)
 *   social_moderation   : 800 base + 100 per hour online
 *
 * The formulas are server-side; the client only sees the
 * final pay_cents and the chosen outcome_id.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type GigId =
  'food_delivery' | 'data_entry' | 'dog_walking' | 'ad_clicks' | 'social_moderation';

export interface GigDefinition {
  readonly gigId: GigId;
  readonly name: string;
  readonly description: string;
  readonly minPayCents: number;
  readonly maxPayCents: number;
}

export interface GigRunRow {
  readonly runId: string;
  readonly gigId: GigId;
  readonly payCents: number;
  readonly outcomeId: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

const GIGS: Record<GigId, GigDefinition> = {
  food_delivery: {
    gigId: 'food_delivery',
    name: 'Food Delivery',
    description: 'Deliver orders around the city; pay scales with distance.',
    minPayCents: 300,
    maxPayCents: 2_000,
  },
  data_entry: {
    gigId: 'data_entry',
    name: 'Data Entry',
    description: 'Process rows of form data; pay scales with accuracy.',
    minPayCents: 200,
    maxPayCents: 700,
  },
  dog_walking: {
    gigId: 'dog_walking',
    name: 'Dog Walking',
    description: 'Walk dogs in the park; pay scales with duration.',
    minPayCents: 500,
    maxPayCents: 1_500,
  },
  ad_clicks: {
    gigId: 'ad_clicks',
    name: 'Ad Clicker',
    description: 'Click on ads; pay scales with click count.',
    minPayCents: 100,
    maxPayCents: 350,
  },
  social_moderation: {
    gigId: 'social_moderation',
    name: 'Social Moderation',
    description: 'Moderate CT feeds; pay scales with hours online.',
    minPayCents: 800,
    maxPayCents: 1_800,
  },
};

interface GigInputs {
  distanceKm: number;
  correctRows: number;
  blocks30min: number;
  clicks: number;
  hoursOnline: number;
}

const DEFAULT_INPUTS: GigInputs = {
  distanceKm: 5,
  correctRows: 8,
  blocks30min: 2,
  clicks: 25,
  hoursOnline: 3,
};

interface GigFormula {
  readonly payCents: (i: GigInputs) => number;
  readonly outcomeId: (i: GigInputs) => string;
}

const FORMULAS: Record<GigId, GigFormula> = {
  food_delivery: {
    payCents: (i) => 300 + Math.max(0, i.distanceKm) * 25,
    outcomeId: (i) =>
      i.distanceKm > 10 ? 'long_route' : i.distanceKm > 5 ? 'mid_route' : 'short_route',
  },
  data_entry: {
    payCents: (i) => 200 + Math.max(0, Math.min(10, i.correctRows)) * 50,
    outcomeId: (i) => (i.correctRows >= 9 ? 'perfect' : i.correctRows >= 5 ? 'good' : 'sloppy'),
  },
  dog_walking: {
    payCents: (i) => 500 + Math.max(0, i.blocks30min) * 200,
    outcomeId: (i) =>
      i.blocks30min >= 4 ? 'big_pack' : i.blocks30min >= 2 ? 'two_dogs' : 'one_dog',
  },
  ad_clicks: {
    payCents: (i) => 100 + Math.max(0, Math.min(50, i.clicks)) * 5,
    outcomeId: (i) => (i.clicks >= 40 ? 'click_storm' : i.clicks >= 20 ? 'regular' : 'light'),
  },
  social_moderation: {
    payCents: (i) => 800 + Math.max(0, i.hoursOnline) * 100,
    outcomeId: (i) =>
      i.hoursOnline >= 4 ? 'long_shift' : i.hoursOnline >= 2 ? 'normal_shift' : 'short_shift',
  },
};

/** List all available gig definitions. */
export function listGigs(): GigDefinition[] {
  return Object.values(GIGS);
}

interface GigRunInput {
  distanceKm?: number;
  correctRows?: number;
  blocks30min?: number;
  clicks?: number;
  hoursOnline?: number;
}

/** Run a gig. The body is the per-gig inputs (optional). */
export async function runGig(
  _ctx: AppContext,
  userId: string,
  gigId: GigId,
  rawInput: GigRunInput = {},
): Promise<GigRunRow> {
  const def = GIGS[gigId];
  if (!def) {
    throw new NotFoundError({ reason: 'unknown gig', gigId });
  }
  const inputs: GigInputs = { ...DEFAULT_INPUTS, ...rawInput };
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new ValidationFailedError({ reason: `input ${k} must be a non-negative number` });
    }
  }
  const formula = FORMULAS[gigId];
  const payCents = formula.payCents(inputs);
  if (payCents < def.minPayCents || payCents > def.maxPayCents) {
    throw new ValidationFailedError({
      reason: 'pay out of bounds',
      payCents,
      min: def.minPayCents,
      max: def.maxPayCents,
    });
  }
  const outcomeId = formula.outcomeId(inputs);
  const runId = uuidv7();
  const startedAt = new Date();
  const endedAt = new Date(startedAt.getTime() + 30_000); // 30s gig duration
  await runInTransaction(async (client) => {
    // Insert the gig_runs row.
    await client.query(
      `INSERT INTO gig_runs (run_id, user_id, gig_id, pay_cents, outcome_id, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [runId, userId, gigId, payCents, outcomeId, startedAt, endedAt],
    );
    // Credit the user's cash.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
      [payCents, userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'gig_pay', 'gig', $3, $4)`,
      [userId, payCents, gigId, `gig-pay:${runId}:${uuidv7()}`],
    );
  });
  return {
    runId,
    gigId,
    payCents,
    outcomeId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };
}
