/**
 * Outfits other players see on top of a player's look. Server-set only: the client has no
 * way to set one. Shared by the realtime rooms (on join) and the api (on change).
 */

/** The outfit name viewers get for the Rekt Burger crew uniform. */
export const OUTFIT_REKT_BURGER_CREW = 'rekt_burger_crew';
/** The cosmetic that, when equipped, shows the crew outfit even off shift. */
export const REKT_BURGER_UNIFORM_ITEM = 'reward_rekt_burger_uniform';

/** The look field the uniform occupies (its cosmetic slot is `top`). Only this field counts. */
export const REKT_BURGER_UNIFORM_LOOK_FIELD = 'topId';

/**
 * SQL columns `on_shift` and `uniform_equipped` for one player, so every reader decides the
 * same way. The uniform counts only when it is in the `topId` field AND the player owns it
 * (`cosmetic_inventory`): a crafted look that carries the key in another field (skinTone,
 * hairId, ...), or in `topId` without owning it, shows nothing. A legacy array look is read at
 * its top index (3).
 * @param userCol - SQL expression for the user id (e.g. `c.user_id`).
 * @param lookCol - SQL expression for the look jsonb (e.g. `c.look`).
 */
export function outfitStateSql(userCol: string, lookCol: string): string {
  return `EXISTS (SELECT 1 FROM rekt_burger_shifts s WHERE s.user_id = ${userCol} AND s.status = 'open') AS on_shift,
          (COALESCE(${lookCol} ->> '${REKT_BURGER_UNIFORM_LOOK_FIELD}', ${lookCol} ->> 3) = '${REKT_BURGER_UNIFORM_ITEM}'
           AND EXISTS (SELECT 1 FROM cosmetic_inventory ci
                         JOIN cosmetic_items it ON it.item_id = ci.item_id
                        WHERE ci.user_id = ${userCol} AND it.item_key = '${REKT_BURGER_UNIFORM_ITEM}')) AS uniform_equipped`;
}

/**
 * The outfit a player shows, decided only from server state: an open Rekt Burger shift, or the
 * Rekt Burger Uniform owned and equipped in its slot. The client has no way to set it.
 * @param onShift - Whether the player has an open Rekt Burger shift.
 * @param uniformEquipped - Whether the uniform is owned and in the `topId` field.
 * @returns The outfit name, or null for none.
 */
export function computeOutfit(onShift: boolean, uniformEquipped: boolean): string | null {
  return onShift || uniformEquipped ? OUTFIT_REKT_BURGER_CREW : null;
}
