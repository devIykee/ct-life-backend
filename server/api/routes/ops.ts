/**
 * Ops routes.
 *
 *   GET  /healthz   liveness
 *   GET  /readyz    readiness (Postgres + Redis + Helius)
 *   GET  /metrics   Prometheus text format (up, event-loop delay, memory, pg pool)
 *   GET  /docs      Redoc HTML (in non-prod)
 */
import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../../application/context.js';
import { renderProcessMetrics, startEventLoopMonitor } from '../../shared/infra/process-metrics.js';

/**
 *
 */
export function registerOpsRoutes(app: FastifyInstance, ctx: AppContext): void {
  startEventLoopMonitor();
  app.get('/healthz', async (_req, reply) => {
    return reply.send({ ok: true, ts: Date.now() });
  });

  app.get('/readyz', async (req, reply) => {
    const checks: Record<string, { ok: boolean; error?: string }> = {};
    try {
      await req.ctx.db.withConnection((c: import('pg').PoolClient) => c.query('SELECT 1'));
      checks.postgres = { ok: true };
    } catch (e) {
      checks.postgres = { ok: false, error: (e as Error).message };
    }
    try {
      const pong = await req.ctx.redis.main.ping();
      checks.redis = { ok: pong === 'PONG' };
    } catch (e) {
      checks.redis = { ok: false, error: (e as Error).message };
    }
    try {
      const r = await req.ctx.helius.health();
      checks.helius = { ok: r === 'ok' };
    } catch (e) {
      checks.helius = { ok: false, error: (e as Error).message };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.status(ok ? 200 : 503).send({ ok, checks });
  });

  app.get('/metrics', async (_req, reply) => {
    // Minimal Prometheus text format. Real metrics land in M5.
    const body = [
      '# HELP ct_life_up Whether the process is up',
      '# TYPE ct_life_up gauge',
      'ct_life_up 1',
      '',
      '# HELP ct_life_info Process info',
      '# TYPE ct_life_info gauge',
      `ct_life_info{app_env="${ctx.config.appEnv}"} 1`,
      '',
    ].join('\n');
    const health = renderProcessMetrics('api', ctx.db.pool);
    return reply.header('content-type', 'text/plain; version=0.0.4').send(body + health);
  });

  // /docs serves the OpenAPI Redoc HTML. The HTML is built by
  // `pnpm contract:codegen`. In production, this path is left in
  // place; protect it at the edge if needed.
  app.get('/docs', async (_req, reply) => {
    const path = join(process.cwd(), 'contract', 'openapi', 'generated', 'index.html');
    if (!existsSync(path)) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'OpenAPI HTML not built yet.', details: {} },
      });
      return;
    }
    const html = readFileSync(path, 'utf8');
    return reply.header('content-type', 'text/html; charset=utf-8').send(html);
  });
}
