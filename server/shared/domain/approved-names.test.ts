/**
 * Approved player-facing names (ct-life-evidence/names/NAMES.md): the old invented
 * names must not come back in contract display text or in the seeded NPC authors.
 * Ids and slugs keep their old spelling; only display text is checked.
 */
import { describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '../db/pool.js';

loadDotenv({ path: process.cwd() + '/.env' });

const OLD = [
  'Rekt Burger',
  'Rug Room',
  'Perp Pit',
  'Rekt Clinic',
  'CT City',
  'CT Jail',
  'Duo Shop',
  'Ratio Arena',
  'Cabal Lounge',
  'Airdrop Season',
  'Launchpad Tower',
  'Prediction Pit',
  'ORE Refinery',
  '(?<!X )Spaces Studio',
  'Club Liquidity',
  'Conference Hall',
  'Discord Heights',
  'Timeline Square',
  'Sybil Barn',
  'Sleuth',
  'Town Crier',
  'Doot the Feed',
  'Candle Carla',
  'Rugwatch Ray',
  'Moonboy Milo',
  'Auntie Ape',
  'Rug Sleuth',
];
// Keys whose values are ids, notes or schema text, not player-facing display text.
const NOT_DISPLAY = /^(_.*|id|slug|\$schema|title|description|miniGameId|deepLink|cosmeticId)$/;

function strings(o: unknown, key: string, out: string[]): void {
  if (Array.isArray(o)) o.forEach((v) => strings(v, key, out));
  else if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => strings(v, k, out));
  else if (typeof o === 'string' && !NOT_DISPLAY.test(key)) out.push(o);
}

describe('approved names', () => {
  it('contract display text uses no retired name', () => {
    const hits: string[] = [];
    for (const dir of ['contract/config', 'contract/ids']) {
      for (const f of readdirSync(dir).filter(
        (n) => n.endsWith('.json') && !n.includes('schema'),
      )) {
        let json: unknown;
        try {
          json = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        } catch {
          continue;
        }
        const out: string[] = [];
        strings(json, '', out);
        for (const s of out)
          for (const old of OLD)
            if (s.includes(old)) hits.push(`${dir}/${f}: "${old}" in "${s.slice(0, 80)}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the seeded NPC authors carry the approved names (migration 105)', async () => {
    const db = createDb();
    const r = await db.withConnection((c) =>
      c.query<{ slug: string; display_name: string }>('SELECT slug, display_name FROM npc_authors'),
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.slug, x.display_name]));
    expect(by).toMatchObject({
      city: 'City News',
      sleuth: 'Police',
      candle_carla: 'Chart Caller',
      rugwatch_ray: 'Rug Watcher',
      moonboy_milo: 'Moon Boy',
      auntie_ape: 'Ape Auntie',
    });
  });
});
