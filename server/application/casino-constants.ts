/**
 * The Rug Room: constants shared by the casino service and the rich-list
 * query in boards.ts. Kept free of imports so boards.ts does not pull in
 * the whole casino.
 */

/** Ledger reasons the casino writes. */
export const CASINO_STAKE = 'casino_stake';
export const CASINO_WIN = 'casino_win';
export const CASINO_REFUND = 'casino_refund';
export const CASINO_LEDGER_REASONS = [CASINO_STAKE, CASINO_WIN, CASINO_REFUND] as const;

/**
 * Anti-grinding: a net casino profit counts at this percentage on the
 * rich-list boards (net_worth, weekly_pnl). A net loss counts in full.
 */
export const CASINO_RICH_LIST_WEIGHT_PCT = 25;

/** The disclaimer every casino response carries. */
export const CASINO_DISCLAIMER = 'Play money. No cash value. 18+';

/** SQL list literal of the casino reasons, for use in queries. */
export const CASINO_REASONS_SQL = `('${CASINO_STAKE}', '${CASINO_WIN}', '${CASINO_REFUND}')`;
