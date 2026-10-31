/**
 * Realtime Origin checks over real sockets: a plain HTTP server wired the way
 * server/realtime/main.ts wires it (the real WebSocketTransport with `originBeforeUpgrade`,
 * Colyseus' own node matchmaking middleware with `installMatchmakeCors`, and
 * `refuseDisallowedMatchmake` in front). Raw HTTP so no WebSocket client library is
 * needed: an accepted handshake answers `101 Switching Protocols`.
 *
 * The full `buildRealtime()` is not booted here: under vitest's fork pool its pm2 IPC
 * metrics call `process.exit` and the Redis presence health-checks other suites' rooms.
 */
import { createServer as createHttpServer, request, type Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeMatchmakingMiddleware, WebSocketTransport } from 'colyseus';
import {
  installMatchmakeCors,
  originBeforeUpgrade,
  refuseDisallowedMatchmake,
} from './origin-guard.js';

const WEB = 'https://play.ctlife.fun';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Attempt a WebSocket handshake; resolve with the HTTP status (101 = upgraded). */
function upgrade(port: number, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/abc/def?sessionId=x',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

describe('realtime Origin allow-list', () => {
  let server: HttpServer;
  let transport: WebSocketTransport;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    const allowed = [WEB];
    installMatchmakeCors(allowed);
    const matchmake = createNodeMatchmakingMiddleware();
    server = createHttpServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200).end('{}');
        return;
      }
      if (refuseDisallowedMatchmake(req, res, allowed)) return;
      void matchmake(req, res, () => res.writeHead(404).end());
    });
    transport = new WebSocketTransport({
      server,
      pingInterval: 0,
      beforeUpgrade: originBeforeUpgrade(allowed),
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    transport.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('upgrades with no Origin (native) and with an allowed Origin', async () => {
    expect(await upgrade(port)).toBe(101);
    expect(await upgrade(port, WEB)).toBe(101);
  });

  it('refuses the upgrade from any other Origin with 403', async () => {
    expect(await upgrade(port, 'https://evil.example')).toBe(403);
    expect(await upgrade(port, 'null')).toBe(403);
    expect(await upgrade(port, 'https://play.ctlife.fun.evil.example')).toBe(403);
  });

  it('matchmake CORS echoes only an allowed Origin, with credentials, never *', async () => {
    const pre = await http(port, 'OPTIONS', '/matchmake/joinOrCreate/city', {
      Origin: WEB,
      'Access-Control-Request-Method': 'POST',
    });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(WEB);
    expect(pre.headers['access-control-allow-credentials']).toBe('true');
    expect(String(pre.headers['access-control-allow-headers'])).toContain('X-Client-Platform');
  });

  it('refuses /matchmake/* from a disallowed Origin with 403', async () => {
    for (const method of ['OPTIONS', 'POST']) {
      const r = await http(port, method, '/matchmake/joinOrCreate/city', {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      });
      expect(r.status, method).toBe(403);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('health paths are untouched', async () => {
    expect((await http(port, 'GET', '/healthz', { Origin: 'https://evil.example' })).status).toBe(
      200,
    );
  });
});
