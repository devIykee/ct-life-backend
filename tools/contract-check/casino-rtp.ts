/**
 * Casino RTP check.
 *
 * Recomputes the slots RTP exactly (all 6^3 weighted outcomes) from
 * `contract/config/casino.json`, requires 94-96%, and requires the file's
 * `computedRtp` to match the recomputed value to 4 decimals. Also checks the
 * crash and coinflip settings land at 94-96%: the crash house edge is
 * 1 - targetRtp, a flip pays payoutMultiplier on a 50% chance. Multipliers
 * must have at most 2 decimals (payouts are computed in hundredths).
 *
 * Run: tsx tools/contract-check/casino-rtp.ts
 */
import {
  readCasinoConfigFile,
  slotsStats,
  SLOT_SYMBOLS,
} from '../../server/application/casino-math';

function main(): void {
  const cfg = readCasinoConfigFile(process.cwd());
  const problems: string[] = [];

  for (const table of ['three', 'two'] as const) {
    for (const s of SLOT_SYMBOLS) {
      const m = cfg.slots.paytable[table][s];
      if (Math.abs(m * 100 - Math.round(m * 100)) > 1e-9) {
        problems.push(`slots.paytable.${table}.${s} = ${m} has more than 2 decimals`);
      }
    }
  }
  const { rtp, sigma, hitRate } = slotsStats(cfg);
  if (rtp < 0.94 || rtp > 0.96) problems.push(`slots RTP ${rtp.toFixed(4)} is outside 94-96%`);
  if (Math.abs(rtp - cfg.slots.computedRtp) > 0.00005) {
    problems.push(
      `slots.computedRtp is ${cfg.slots.computedRtp} but the paytable computes ${rtp.toFixed(4)}`,
    );
  }
  if (cfg.crash.targetRtp < 0.94 || cfg.crash.targetRtp > 0.96) {
    problems.push(`crash.targetRtp ${cfg.crash.targetRtp} is outside 94-96%`);
  }
  const flip = cfg.coinflip.payoutMultiplier / 2;
  if (flip < 0.94 || flip > 0.96) problems.push(`coinflip RTP ${flip} is outside 94-96%`);
  const h2h = 1 - cfg.coinflip.h2hHouseCutBps / 10_000;
  if (h2h < 0.94 || h2h > 0.96) problems.push(`head-to-head RTP ${h2h} is outside 94-96%`);

  if (problems.length > 0) {
    for (const p of problems) console.log(`[FAIL] casino.json: ${p}`);
    process.exit(1);
  }
  console.log(
    `[OK] casino.json: slots RTP ${(rtp * 100).toFixed(2)}% (sigma ${sigma.toFixed(2)}, hit ${(hitRate * 100).toFixed(1)}%), ` +
      `crash ${cfg.crash.targetRtp * 100}%, coinflip ${flip * 100}%, head-to-head ${h2h * 100}%`,
  );
}

main();
