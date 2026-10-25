/**
 * Character service.
 *
 * Creates the character row, inserts the initial needs (50/50/50/50/50)
 * and skills (1/1/1/1/1/1) rows, and sets the home_id. Alias must
 * be unique across the table; the unique index surfaces a 23505
 * which the service maps to AliasTakenError.
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  AliasTakenError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { ConfigCache } from './context.js';
import { validateCharacterPalette } from '../shared/domain/character-palettes.js';

interface TribesConfig {
  tribes: Array<{ id: string }>;
}

interface DreamsConfig {
  dreams: Array<{ id: string }>;
}

interface TraitsConfig {
  traits: Array<{ id: string }>;
}

interface LotteryConfig {
  outcomes: Record<string, { homeId: string }>;
}

interface ItemsConfig {
  items: Array<{ id: string; slot: string }>;
}

export interface CharacterInput {
  readonly likenessJobId?: string;
  readonly alias: string;
  readonly look: {
    readonly skinTone: string;
    readonly headId: string;
    readonly hairId: string;
    readonly topId: string;
    readonly bottomId: string;
    readonly shoesId: string;
    readonly accId: string;
  };
  readonly traitIds: readonly [string, string];
  readonly dreamId: string;
  readonly tribeId: string;
}

export class CharacterService {
  /**
   * @param configCache - Cache used to load the tribes, dreams, traits, and
   * items configs that character input is validated against.
   */
  constructor(private readonly configCache: ConfigCache) {}

  /**
   * B13 fix: Validate tribe/dream/trait/look IDs against contract configs
   */
  private validateInput(input: CharacterInput): void {
    validateCharacterPalette(input.look);
    const tribes = this.configCache.load<TribesConfig>('tribes');
    const dreams = this.configCache.load<DreamsConfig>('dreams');
    const traits = this.configCache.load<TraitsConfig>('traits');
    const items = this.configCache.load<ItemsConfig>('items');

    const validTribeIds = new Set(tribes.tribes.map((t: { id: string }) => t.id));
    const validDreamIds = new Set(dreams.dreams.map((d: { id: string }) => d.id));
    const validTraitIds = new Set(traits.traits.map((t: { id: string }) => t.id));

    if (!validTribeIds.has(input.tribeId)) {
      throw new ValidationFailedError({ reason: 'invalid_tribe_id', tribeId: input.tribeId });
    }
    if (!validDreamIds.has(input.dreamId)) {
      throw new ValidationFailedError({ reason: 'invalid_dream_id', dreamId: input.dreamId });
    }
    if (input.traitIds.length !== 2) {
      throw new ValidationFailedError({ reason: 'must_provide_two_traits' });
    }
    for (const traitId of input.traitIds) {
      if (!validTraitIds.has(traitId)) {
        throw new ValidationFailedError({ reason: 'invalid_trait_id', traitId });
      }
    }
    if (input.traitIds[0] === input.traitIds[1]) {
      throw new ValidationFailedError({ reason: 'traits_must_be_distinct' });
    }

    // Validate look items exist and match their slots
    const lookItems = [
      { id: input.look.headId, slot: 'head' },
      { id: input.look.hairId, slot: 'hair' },
      { id: input.look.topId, slot: 'top' },
      { id: input.look.bottomId, slot: 'bottom' },
      { id: input.look.shoesId, slot: 'shoes' },
      { id: input.look.accId, slot: 'acc' },
    ];

    // contract/ids/items.json is the shop catalogue: `{items: [{id, slot}]}`.
    // It holds purchasable cosmetics only, not the creator's base-look ids
    // (head_<look>, hair_<look>, acc_none, ...), which are FE-owned and
    // never appear here. So an id that is in the catalogue must sit in the
    // right slot, and an id that is not is accepted as a base look. The
    // alternative, rejecting unknown ids, fails every real character
    // submit.
    const slotById = new Map(items.items.map((i) => [i.id, i.slot]));

    for (const { id, slot } of lookItems) {
      if (typeof id !== 'string' || id === '') {
        throw new ValidationFailedError({ reason: 'invalid_look_item', itemId: id, slot });
      }
      const knownSlot = slotById.get(id);
      if (knownSlot !== undefined && knownSlot !== slot) {
        throw new ValidationFailedError({
          reason: 'look_item_wrong_slot',
          itemId: id,
          expected: slot,
          actual: knownSlot,
        });
      }
    }

    // The contract types Look.skinTone as a free string (its own example
    // is 'tan'), so only emptiness is rejected. The previous
    // /^skin_tone[1-6]$/ rule was not in the contract and refused every
    // tone the creator sends.
    if (typeof input.look.skinTone !== 'string' || input.look.skinTone.trim() === '') {
      throw new ValidationFailedError({
        reason: 'invalid_skin_tone',
        skinTone: input.look.skinTone,
      });
    }
  }

  /**
   * The home a lottery outcome lands the player in, read from
   * lottery.json so the roll screen and the character always agree.
   * An unknown or missing outcome falls back to exit_liquidity's home.
   */
  private originHomeId(outcome: string | undefined): string {
    const lottery = this.configCache.load<LotteryConfig>('lottery');
    const out =
      (outcome !== undefined ? lottery.outcomes[outcome] : undefined) ??
      lottery.outcomes['exit_liquidity'];
    if (out === undefined) {
      throw new ValidationFailedError({ reason: 'lottery_outcome_unknown', outcome });
    }
    return out.homeId;
  }

  /**
   * Create a character for the user. Throws AliasTakenError on
   * duplicate alias and ForbiddenError if the user already has one.
   */
  async create(
    userId: string,
    input: CharacterInput,
  ): Promise<{
    alias: string;
    look: unknown;
    tribeId: string;
    traitIds: string[];
    dreamId: string;
    homeId: string;
    likenessJobId: string | null;
  }> {
    // B13 fix: Validate all IDs before attempting creation
    this.validateInput(input);

    return runInTransaction(async (client) => {
      // Already has a character?
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM characters WHERE user_id = $1',
        [userId],
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ForbiddenError({ reason: 'character_exists' });
      }
      // User must exist and must have rolled the lottery
      const u = await client.query<{ id: string; lottery_rolled_at: Date | null }>(
        'SELECT id, lottery_rolled_at FROM users WHERE id = $1',
        [userId],
      );
      if ((u.rowCount ?? 0) === 0) {
        throw new NotFoundError({ kind: 'user', id: userId });
      }
      if (u.rows[0]!.lottery_rolled_at === null) {
        throw new ForbiddenError({ reason: 'must_roll_lottery_first' });
      }

      // The origin home is whatever the rolled outcome promised in
      // lottery.json; the payout's ref_id is the outcome id.
      const lotteryEntry = await client.query<{ ref_id: string }>(
        `SELECT ref_id FROM ledger_entries
         WHERE user_id = $1 AND reason = 'lottery_payout'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      const homeId = this.originHomeId(lotteryEntry.rows[0]?.ref_id);

      const id = uuidv7();
      if (input.likenessJobId) {
        const owned = await client.query(
          `SELECT j.id FROM likeness_jobs j JOIN likeness_selections s ON s.job_id=j.id AND s.user_id=j.user_id
           WHERE j.id=$1 AND j.user_id=$2 AND j.status='succeeded' AND j.phase='completed'
           AND j.asset_validated_at IS NOT NULL AND j.asset_manifest IS NOT NULL
           AND j.artifact_cleanup_at IS NULL AND j.model_id=$3 FOR UPDATE OF j`,
          [input.likenessJobId, userId, input.look.headId],
        );
        if (!owned.rowCount)
          throw new ForbiddenError({ reason: 'owned_accepted_likeness_required' });
      }
      try {
        await client.query(
          `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, age_confirmed_at, home_id,likeness_job_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8,$9)`,
          [
            id,
            userId,
            input.alias,
            input.look,
            input.tribeId,
            input.traitIds,
            input.dreamId,
            homeId,
            input.likenessJobId ?? null,
          ],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new AliasTakenError({ alias: input.alias });
        }
        throw e;
      }
      // Initial needs + skills.
      await client.query(
        `INSERT INTO needs (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await client.query(
        `INSERT INTO skills (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      return {
        alias: input.alias,
        look: input.look,
        tribeId: input.tribeId,
        traitIds: [...input.traitIds],
        dreamId: input.dreamId,
        homeId,
        likenessJobId: input.likenessJobId ?? null,
      };
    });
  }
}
