/**
 * Outfits other players see on top of a player's look. Server-set only: the client has no
 * way to set one. Shared by the realtime rooms (on join) and the api (on change).
 */

/** The outfit name viewers get for the Rekt Burger crew uniform. */
export const OUTFIT_REKT_BURGER_CREW = 'rekt_burger_crew';
/** The cosmetic that, when equipped, shows the crew outfit even off shift. */
export const REKT_BURGER_UNIFORM_ITEM = 'reward_rekt_burger_uniform';

/**
 * The outfit a player shows, decided only from server state: an open Rekt Burger shift, or the
 * Rekt Burger Uniform equipped in the look. The client has no way to set it.
 * @param onShift - Whether the player has an open Rekt Burger shift.
 * @param look - The look array (skinTone, head, hair, top, bottom, shoes, acc).
 * @returns The outfit name, or null for none.
 */
export function computeOutfit(onShift: boolean, look: readonly string[]): string | null {
  if (onShift || look.includes(REKT_BURGER_UNIFORM_ITEM)) return OUTFIT_REKT_BURGER_CREW;
  return null;
}
