/**
 * Character service.
 *
 * Creates the character row, inserts the initial needs (50/50/50/50/50)
 * and skills (1/1/1/1/1/1) rows, and sets the home_id. Alias must
 * be unique across the table; the unique index surfaces a 23505
 * which the service maps to AliasTakenError.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { AliasTakenError, ForbiddenError, NotFoundError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';

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
    return runInTransaction(async (client) => {
      // Already has a character?
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM characters WHERE user_id = $1',
        [userId],
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ForbiddenError({ reason: 'character_exists' });
      }
      // User must exist.
      const u = await client.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId]);
      if ((u.rowCount ?? 0) === 0) {
        throw new NotFoundError({ kind: 'user', id: userId });
      }
      const id = uuidv7();
      try {
        await client.query(
          `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, age_confirmed_at, home_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'parents_basement')`,
          [id, userId, input.alias, input.look, input.tribeId, input.traitIds, input.dreamId],
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
        homeId: 'parents_basement',
      };
    });
  }
}
