/**
 * Projects service tests.
 *
 * Covers: found (seed debit + ledger row), insufficient cash
 * refusal, hire (payroll debit + credit + hire row), launch
 * status flip, getProject + hires listing, idempotent
 * double-hire refused, non-owner ConflictError.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ConflictError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let ownerId: string;
let hireeId: string;
let otherId: string;

beforeAll(async () => {
  ownerId = uuidv7();
  hireeId = uuidv7();
  otherId = uuidv7();
  for (const id of [ownerId, hireeId, otherId]) {
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `projUser-${id}`]);
  }
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `DELETE FROM project_hires WHERE project_id IN (SELECT project_id FROM projects WHERE owner_user_id = $1)`,
    [ownerId],
  );
  await pool.query(`DELETE FROM projects WHERE owner_user_id = $1`, [ownerId]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 10000000), ($2, 0), ($3, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = EXCLUDED.cash_cents`,
    [ownerId, hireeId, otherId],
  );
});

describe('projects service', () => {
  it('foundProject debits the seed and writes a projects row', async () => {
    const ctx = buildContext();
    const { foundProject } = await import('./projects.js');
    const before = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [ownerId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    const out = await foundProject(ctx, ownerId, 'memecoin');
    expect(out.status).toBe('founded');
    expect(out.cashCents).toBe(50_000);
    const after = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [ownerId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    expect(after).toBe(before - 50_000);
    const led = await pool.query<{ reason: string }>(
      `SELECT reason FROM ledger_entries WHERE user_id = $1 AND reason = 'project_seed' ORDER BY created_at DESC LIMIT 1`,
      [ownerId],
    );
    expect(led.rows[0]?.reason).toBe('project_seed');
  });

  it('insufficient cash refuses the found', async () => {
    const ctx = buildContext();
    const { foundProject } = await import('./projects.js');
    await pool.query(`UPDATE balances SET cash_cents = 0 WHERE user_id = $1`, [ownerId]);
    await expect(foundProject(ctx, ownerId, 'l2')).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('hirePlayer debits salary from owner, credits hiree, writes project_hires row', async () => {
    const ctx = buildContext();
    const { foundProject, hirePlayer } = await import('./projects.js');
    const p = await foundProject(ctx, ownerId, 'memecoin');
    const ownerBefore = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [ownerId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    const hireeBefore = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [hireeId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    const out = await hirePlayer(ctx, ownerId, p.projectId, {
      userId: hireeId,
      role: 'dev',
      salaryCentsPerWeek: 5000,
    });
    expect(out.salaryCentsPerWeek).toBe(5000);
    const ownerAfter = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [ownerId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    const hireeAfter = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [hireeId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    expect(ownerAfter).toBe(ownerBefore - 5000);
    expect(hireeAfter).toBe(hireeBefore + 5000);
  });

  it('double-hire is refused with ConflictError (UNIQUE project_id+user_id)', async () => {
    const ctx = buildContext();
    const { foundProject, hirePlayer } = await import('./projects.js');
    const p = await foundProject(ctx, ownerId, 'memecoin');
    await hirePlayer(ctx, ownerId, p.projectId, {
      userId: hireeId,
      role: 'dev',
      salaryCentsPerWeek: 1000,
    });
    await expect(
      hirePlayer(ctx, ownerId, p.projectId, {
        userId: hireeId,
        role: 'mod',
        salaryCentsPerWeek: 2000,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('non-owner hiring is refused with ConflictError', async () => {
    const ctx = buildContext();
    const { foundProject, hirePlayer } = await import('./projects.js');
    const p = await foundProject(ctx, ownerId, 'memecoin');
    await expect(
      hirePlayer(ctx, otherId, p.projectId, {
        userId: hireeId,
        role: 'dev',
        salaryCentsPerWeek: 1000,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('launchProject flips founded -> launching', async () => {
    const ctx = buildContext();
    const { foundProject, launchProject } = await import('./projects.js');
    const p = await foundProject(ctx, ownerId, 'memecoin');
    const out = await launchProject(ctx, ownerId, p.projectId);
    expect(out.status).toBe('launching');
  });

  it('launching a non-founded project raises NotFoundError', async () => {
    const ctx = buildContext();
    const { foundProject, launchProject } = await import('./projects.js');
    const p = await foundProject(ctx, ownerId, 'memecoin');
    await launchProject(ctx, ownerId, p.projectId);
    await expect(launchProject(ctx, ownerId, p.projectId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getProject returns the project + hires', async () => {
    const ctx = buildContext();
    const { foundProject, hirePlayer, getProject } = await import('./projects.js');
    const p = await foundProject(ctx, ownerId, 'memecoin');
    await hirePlayer(ctx, ownerId, p.projectId, {
      userId: hireeId,
      role: 'dev',
      salaryCentsPerWeek: 1000,
    });
    const got = await getProject(ctx, p.projectId);
    expect(got.project.status).toBe('founded');
    expect(got.hires.length).toBe(1);
    expect(got.hires[0]!.userId).toBe(hireeId);
  });
});
