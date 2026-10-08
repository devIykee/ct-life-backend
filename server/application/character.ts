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

interface TribesConfig {
  tribes: Array<{ id: string }>;
}

interface DreamsConfig {
  dreams: Array<{ id: string }>;
}

interface TraitsConfig {
  traits: Array<{ id: string }>;
}

interface ItemsConfig {
  items: Record<string, { slot: string }>;
}

export interface CharacterInput {
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

    for (const { id, slot } of lookItems) {
      const item = items.items[id];
      if (!item) {
        throw new ValidationFailedError({ reason: 'invalid_look_item', itemId: id });
      }
      if (item.slot !== slot) {
        throw new ValidationFailedError({
          reason: 'look_item_wrong_slot',
          itemId: id,
          expected: slot,
          actual: item.slot,
        });
      }
    }

    // Validate skinTone (skin_tone1 through skin_tone6)
    if (!/^skin_tone[1-6]$/.test(input.look.skinTone)) {
      throw new ValidationFailedError({ reason: 'invalid_skin_tone', skinTone: input.look.skinTone });
    }
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

      // B13 fix: Get home_id from the lottery outcome (stored in ledger ref_id)
      const lotteryEntry = await client.query<{ ref_id: string }>(
        `SELECT ref_id FROM ledger_entries
         WHERE user_id = $1 AND reason = 'lottery_payout'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      const lotteryOutcome = lotteryEntry.rows[0]?.ref_id ?? 'exit_liquidity';

      // Map outcome to home_id (from lottery.json outcomes)
      const homeIdMap: Record<string, string> = {
        seeker: 'penthouse',
        insider: 'skyrise',
        exit_liquidity: 'parents_basement',
      };
      const homeId = homeIdMap[lotteryOutcome] ?? 'parents_basement';

      const id = uuidv7();
      try {
        await client.query(
          `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, age_confirmed_at, home_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
          [id, userId, input.alias, input.look, input.tribeId, input.traitIds, input.dreamId, homeId],
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
      };
    });
  }
}
