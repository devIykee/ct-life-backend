/**
 * Grant or revoke a player entitlement by hand (ops, QA, the dev showcase).
 *
 *   pnpm tsx tools/scripts/entitlement-grant.ts <wallet> [itemKey] [--revoke] [--note "why"]
 *
 * itemKey defaults to vehicle.hovercar. Rows made here have source 'grant';
 * the wallet sync never touches them.
 */
import { config as loadDotenv } from 'dotenv';
import { buildContext } from '../../server/application/context.js';
import {
  HOVERCAR,
  grantEntitlement,
  revokeEntitlement,
} from '../../server/application/entitlements.js';

loadDotenv({ path: process.cwd() + '/.env' });

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const noteAt = args.indexOf('--note');
const note = noteAt >= 0 ? (args[noteAt + 1] ?? '') : 'ops grant';
const positional = args.filter((a, i) => !a.startsWith('--') && i !== noteAt + 1);
const [wallet, itemKey = HOVERCAR] = positional;

if (!wallet) {
  console.error('usage: entitlement-grant.ts <wallet> [itemKey] [--revoke] [--note "why"]');
  process.exit(2);
}

const ctx = buildContext();
const user = await ctx.db.withConnection((c) =>
  c.query<{ id: string }>(`SELECT id FROM users WHERE wallet = $1`, [wallet]),
);
const userId = user.rows[0]?.id;
if (!userId) {
  console.error(`no player with wallet ${wallet}`);
  process.exit(1);
}

const changed = revoke
  ? await revokeEntitlement(ctx, userId, itemKey, 'grant')
  : await grantEntitlement(ctx, userId, itemKey, 'grant', note);
console.log(
  `${revoke ? 'revoke' : 'grant'} ${itemKey} for ${wallet}: ${changed ? 'done' : 'no change'}`,
);
process.exit(0);
