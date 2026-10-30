-- Migration: 105_approved_names
--
-- The user approved real, relatable names for everything a player sees
-- (ct-life-evidence/names/NAMES.md, client table contract/ids/names.json).
-- Ids and slugs do not change; only display text stored in rows that earlier
-- migrations or runtime seeding already wrote.
--
--   npc_authors.display_name  City News / Police / the four callers
--   cosmetic_items.name       McDonald's Uniform, S1 Season Tee
--   feed_posts.text           old posts that name a renamed place or brand, so the
--                             history reads the same as new posts

-- Up Migration
UPDATE npc_authors SET display_name = 'City News' WHERE slug = 'city' AND display_name = 'CT City';
UPDATE npc_authors SET display_name = 'Police' WHERE slug = 'sleuth' AND display_name = 'The Sleuth';
UPDATE npc_authors SET display_name = 'Chart Caller' WHERE slug = 'candle_carla' AND display_name = 'Candle Carla';
UPDATE npc_authors SET display_name = 'Rug Watcher' WHERE slug = 'rugwatch_ray' AND display_name = 'Rugwatch Ray';
UPDATE npc_authors SET display_name = 'Moon Boy' WHERE slug = 'moonboy_milo' AND display_name = 'Moonboy Milo';
UPDATE npc_authors SET display_name = 'Ape Auntie' WHERE slug = 'auntie_ape' AND display_name = 'Auntie Ape';

UPDATE cosmetic_items SET name = 'McDonald''s Uniform' WHERE item_key = 'reward_rekt_burger_uniform';
UPDATE cosmetic_items SET name = 'S1 Season Tee' WHERE item_key = 'reward_s1_airdrop_tee';

UPDATE feed_posts
   SET text = replace(replace(replace(replace(text,
         'liquidated in the Perp Pit', 'liquidated on Hyperliquid'),
         'in the Rug Room', 'in the Casino'),
         'Rekt Burger', 'McDonald''s'),
         'CT Jail', 'Jail')
 WHERE text LIKE '%Perp Pit%' OR text LIKE '%Rug Room%' OR text LIKE '%Rekt Burger%' OR text LIKE '%CT Jail%';

-- Down Migration
UPDATE npc_authors SET display_name = 'CT City' WHERE slug = 'city';
UPDATE npc_authors SET display_name = 'The Sleuth' WHERE slug = 'sleuth';
UPDATE npc_authors SET display_name = 'Candle Carla' WHERE slug = 'candle_carla';
UPDATE npc_authors SET display_name = 'Rugwatch Ray' WHERE slug = 'rugwatch_ray';
UPDATE npc_authors SET display_name = 'Moonboy Milo' WHERE slug = 'moonboy_milo';
UPDATE npc_authors SET display_name = 'Auntie Ape' WHERE slug = 'auntie_ape';
UPDATE cosmetic_items SET name = 'Rekt Burger Uniform' WHERE item_key = 'reward_rekt_burger_uniform';
UPDATE cosmetic_items SET name = 'S1 Airdrop Season Tee' WHERE item_key = 'reward_s1_airdrop_tee';
