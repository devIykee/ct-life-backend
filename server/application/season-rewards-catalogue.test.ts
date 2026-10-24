/**
 * Guard: every furniture reward in season_tracks.json must exist in the Duo Shop
 * catalogue (shop_items.json). The two files are owned separately; a reward that
 * points at a removed item makes the tier claim fail with a 500.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), 'contract', rel), 'utf8')) as T;
}

describe('season furniture rewards', () => {
  it('only reference items in the shop catalogue', () => {
    const shop = readJson<{ items: { itemId: string }[] }>('ids/shop_items.json');
    const ids = new Set(shop.items.map((i) => i.itemId));
    const raw = readFileSync(join(process.cwd(), 'contract/config/season_tracks.json'), 'utf8');
    const refs = [...raw.matchAll(/"furnitureItemId":\s*"([a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !ids.has(r))).toEqual([]);
  });
});
