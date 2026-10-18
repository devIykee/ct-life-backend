/**
 * Build contract/ids/districts.json from the frontend's island plan.
 *
 * The frontend generates CT Island with tools/world/islandgen and writes
 * out/plan.json. The street and vehicles rooms only need the land
 * outline and the district polygons, in island metres (+X east, +Z
 * north, origin at the downtown plaza).
 *
 * Land is a list of polygons: the main coast, the islet (a circle) and
 * the causeway to it (a strip along its path). Venue placements (origin,
 * yaw in degrees clockwise from north, door) let venue rooms speak
 * island coordinates.
 *
 * Run: pnpm tsx tools/scripts/import-districts.ts <path/to/plan.json> [source-label]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Pt = [number, number];

interface Plan {
  coast: Array<[number, number, number]>;
  districts: Array<{ id: string; name: string; poly: Pt[] }>;
  venues?: Array<{
    id: string;
    district: string;
    origin: [number, number, number];
    yaw: number;
    door: [number, number, number];
  }>;
  islet?: { center: Pt; radius: number };
  causeway?: { path: Pt[]; half_width: number };
}

const round = (n: number): number => Math.round(n * 100) / 100;

function circle(c: Pt, r: number, n = 32): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [round(c[0] + r * Math.cos(a)), round(c[1] + r * Math.sin(a))] as Pt;
  });
}

/** Outline of a path widened by `hw` on each side (ends squared off). */
function strip(path: Pt[], hw: number): Pt[] {
  const left: Pt[] = [];
  const right: Pt[] = [];
  path.forEach((p, i) => {
    const a = path[Math.max(0, i - 1)]!;
    const b = path[Math.min(path.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * hw;
    const nz = (dx / len) * hw;
    left.push([round(p[0] + nx), round(p[1] + nz)]);
    right.push([round(p[0] - nx), round(p[1] - nz)]);
  });
  return [...left, ...right.reverse()];
}

function main(): void {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: import-districts.ts <plan.json> [source-label]');
    process.exit(1);
  }
  const label = process.argv[3] ?? src;
  const plan = JSON.parse(readFileSync(src, 'utf8')) as Plan;
  const island: Pt[][] = [plan.coast.map(([x, , z]) => [round(x), round(z)] as Pt)];
  if (plan.islet) island.push(circle(plan.islet.center, plan.islet.radius));
  if (plan.causeway) island.push(strip(plan.causeway.path, plan.causeway.half_width));
  const districts: Record<string, Pt[]> = {};
  for (const d of plan.districts) districts[d.id] = d.poly.map(([x, z]) => [x, z] as Pt);
  const venues: Record<string, unknown> = {};
  for (const v of plan.venues ?? []) {
    venues[v.id] = {
      district: v.district,
      origin: v.origin.map(round),
      yaw: round(v.yaw),
      door: [round(v.door[0]), round(v.door[2])],
    };
  }
  const out = {
    _owner: 'FE',
    _provisional: false,
    version: '1.0.0',
    _note: `CT Island v2 bounds for the street and vehicles rooms, generated from the frontend island plan (${label}) by tools/scripts/import-districts.ts. Island metres, +X east, +Z north, origin at the downtown plaza. \`island\` is a list of land polygons (coast, islet, causeway); \`districts\` maps each district id to its polygon. \`venues\` places each venue's local frame on the island: origin [x, y, z], yaw in degrees clockwise from north, door [x, z]. Points are [x, z].`,
    units: 'island metres',
    island,
    districts,
    venues,
  };
  const dest = join(process.cwd(), 'contract', 'ids', 'districts.json');
  writeFileSync(dest, JSON.stringify(out) + '\n');
  console.log(
    `wrote ${dest}: ${island.length} land polygons, ${Object.keys(venues).length} venues, districts ${Object.keys(districts).join(', ')}`,
  );
}

main();
