/** Real loopback HTTP contract fixtures; no live generation and no provider key. */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TripoAdapter } from './tripo.js';

let server: Server;
let endpoint: string;
let requests: Array<{ path: string; headers: IncomingMessage['headers']; body: string }>;
let respond: (response: ServerResponse) => void;
const pngHeader = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const config = { apiKey: 'fixture-only-not-a-credential', endUserAgreementConfirmed: true };

beforeEach(async () => {
  requests = [];
  respond = (res) => res.end(JSON.stringify({ code: 0, data: { task_id: 'task-123' } }));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    requests.push({
      path: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('Tripo adapter', () => {
  it('requires a key and explicit provider-use authorization before sending bytes', async () => {
    for (const setting of [
      { ...config, apiKey: '' },
      { ...config, endUserAgreementConfirmed: false },
    ]) {
      await expect(
        new TripoAdapter(setting, endpoint).uploadImage(pngHeader, 'png'),
      ).rejects.toMatchObject({ details: { reason: 'provider_not_configured' } });
    }
    expect(requests).toHaveLength(0);
  });
  it('supports separately authorized operator evaluation without enabling the public product', async () => {
    const evaluation = new TripoAdapter(
      { ...config, endUserAgreementConfirmed: false, authorizedOperatorEvaluation: true },
      endpoint,
    );
    expect(await evaluation.generate('synthetic-image-token', 'png', 42)).toBe('task-123');
    expect(requests).toHaveLength(1);
    await expect(
      new TripoAdapter(
        {
          ...config,
          apiKey: '',
          endUserAgreementConfirmed: false,
          authorizedOperatorEvaluation: true,
        },
        endpoint,
      ).generate('synthetic-image-token', 'png', 42),
    ).rejects.toMatchObject({ details: { reason: 'provider_not_configured' } });
    expect(requests).toHaveLength(1);
  });
  it('reads fractional available/frozen credits without a paid submission', async () => {
    respond = (res) =>
      res.end(JSON.stringify({ code: 0, data: { balance: 199.5, frozen: 10.25 } }));
    expect(await new TripoAdapter(config, endpoint).balance()).toEqual({
      balance: 199.5,
      frozen: 10.25,
    });
    expect(requests[0]?.path).toBe('/user/balance');
    respond = (res) => res.end(JSON.stringify({ code: 0, data: { balance: -1, frozen: 0 } }));
    await expect(new TripoAdapter(config, endpoint).balance()).rejects.toMatchObject({
      details: { reason: 'invalid_provider_balance_response' },
    });
  });
  it('sends multipart bytes with bearer auth to the upload endpoint', async () => {
    respond = (res) => res.end(JSON.stringify({ code: 0, data: { image_token: 'image-token' } }));
    expect(await new TripoAdapter(config, endpoint).uploadImage(pngHeader, 'png')).toBe(
      'image-token',
    );
    expect(requests[0]?.path).toBe('/upload');
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${config.apiKey}`);
    expect(requests[0]?.headers['content-type']).toContain('multipart/form-data');
    expect(requests[0]?.body).toContain('name="file"');
  });
  it('pins model, budget, seed and token input without an arbitrary image URL', async () => {
    expect(await new TripoAdapter(config, endpoint).generate('image-token', 'png', 42)).toBe(
      'task-123',
    );
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      type: 'image_to_model',
      model_version: 'v3.1-20260211',
      file: { type: 'png', file_token: 'image-token' },
      model_seed: 42,
      texture_seed: 42,
      face_limit: 6000,
      smart_low_poly: true,
    });
    expect(JSON.parse(requests[0]!.body).file).not.toHaveProperty('url');
  });
  it('requests a biped GLB rig', async () => {
    await new TripoAdapter(config, endpoint).rig('generated-123');
    expect(JSON.parse(requests[0]!.body)).toEqual({
      type: 'animate_rig',
      original_model_task_id: 'generated-123',
      model_version: 'v2.5-20260210',
      rig_type: 'biped',
      spec: 'tripo',
      out_format: 'glb',
    });
  });
  it('uses the documented humanoid model and Mixamo specification for humans', async () => {
    await new TripoAdapter(config, endpoint).rigHuman('generated-123');
    expect(JSON.parse(requests[0]!.body)).toEqual({
      type: 'animate_rig',
      original_model_task_id: 'generated-123',
      model_version: 'v1.0-20240301',
      rig_type: 'biped',
      spec: 'mixamo',
      out_format: 'glb',
    });
  });
  it.each(['head_snow', 'head_pm_shark'])(
    'conditions %s with character and own-face tokens before 3D',
    async (modelId) => {
      await new TripoAdapter(config, endpoint).prepareReference(
        modelId,
        { token: 'base-reference', type: 'png' },
        { token: 'own-face', type: 'jpeg' },
      );
      const sent = JSON.parse(requests[0]!.body);
      expect(sent).toMatchObject({
        type: 'generate_image',
        model_version: 'gemini_3.1_flash_image_preview',
        t_pose: true,
        files: [
          { type: 'png', file_token: 'base-reference' },
          { type: 'jpeg', file_token: 'own-face' },
        ],
      });
      expect(sent.prompt).toContain(
        modelId === 'head_snow' ? 'adult human body' : 'Do not paste a human head',
      );
      expect(sent.prompt.length).toBeLessThanOrEqual(1024);
    },
  );
  it('requests pre-rig suitability and retains explicit biped result', async () => {
    const adapter = new TripoAdapter(config, endpoint);
    await adapter.preRigCheck('generated-123');
    expect(JSON.parse(requests[0]!.body)).toEqual({
      type: 'animate_prerigcheck',
      original_model_task_id: 'generated-123',
    });
    respond = (res) =>
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            task_id: 'task-123',
            status: 'success',
            output: { riggable: true, rig_type: 'biped' },
          },
        }),
      );
    expect((await adapter.status('task-123')).output).toEqual({
      riggable: true,
      rig_type: 'biped',
    });
  });
  it('does not condition an unsupported identity or covered face', async () => {
    const adapter = new TripoAdapter(config, endpoint);
    for (const id of ['head_unknown', 'head_hero_hazmat', 'head_hero_balaclava']) {
      await expect(
        adapter.prepareReference(
          id,
          { token: 'base', type: 'png' },
          { token: 'face', type: 'jpeg' },
        ),
      ).rejects.toMatchObject({ httpStatus: 400 });
    }
    expect(requests).toHaveLength(0);
  });
  it.each(['queued', 'running', 'success', 'failed', 'banned', 'expired', 'cancelled', 'unknown'])(
    'validates and maps status %s',
    async (status) => {
      respond = (res) =>
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              task_id: 'task-123',
              status,
              progress: 50,
              consumed_credit: 30,
              output: { model: 'https://example.com/result.glb' },
            },
          }),
        );
      const result = await new TripoAdapter(config, endpoint).status('task-123');
      expect(result.status).toBe(status);
      expect(result.consumedCredits).toBe(30);
      expect(requests).toHaveLength(1); // Status reads never download returned URLs.
    },
  );
  it.each([
    { task_id: 'wrong-id', status: 'success' },
    { task_id: 'task-123', status: 'invented' },
    { task_id: 'task-123', status: 'success', output: { model: 'file:///etc/passwd' } },
  ])('refuses malformed or mismatched provider result', async (data) => {
    respond = (res) => res.end(JSON.stringify({ code: 0, data }));
    await expect(new TripoAdapter(config, endpoint).status('task-123')).rejects.toMatchObject({
      details: { reason: 'invalid_provider_task_response' },
    });
  });
  it('bounds a stalled request and never retries an ambiguous paid POST', async () => {
    respond = () => {};
    await expect(
      new TripoAdapter({ ...config, timeoutMs: 30 }, endpoint).generate('image-token', 'png', 1),
    ).rejects.toMatchObject({ submissionUnknown: true });
    expect(requests).toHaveLength(1);
  });
  it('does not echo upstream errors or credentials', async () => {
    respond = (res) => {
      res.statusCode = 500;
      res.end('private upstream body');
    };
    try {
      await new TripoAdapter(config, endpoint).generate('image-token', 'png', 1);
    } catch (error) {
      expect(String(error)).not.toContain('private upstream body');
      expect(String(error)).not.toContain(config.apiKey);
    }
    expect(requests).toHaveLength(1);
  });
  it('refuses redirects instead of forwarding bearer credentials', async () => {
    respond = (res) => {
      res.writeHead(302, { location: 'https://example.com/' });
      res.end();
    };
    await expect(new TripoAdapter(config, endpoint).status('task-123')).rejects.toMatchObject({
      httpStatus: 503,
    });
    expect(requests).toHaveLength(1);
  });
  it('rejects URLs as task IDs, invalid images and nonfixture API hosts', async () => {
    const adapter = new TripoAdapter(config, endpoint);
    await expect(adapter.status('https://example.com/task')).rejects.toMatchObject({
      httpStatus: 400,
    });
    await expect(adapter.uploadImage(new Uint8Array([1, 2, 3]), 'png')).rejects.toMatchObject({
      httpStatus: 400,
    });
    expect(() => new TripoAdapter(config, 'https://example.com')).toThrow();
    expect(requests).toHaveLength(0);
  });
  it('bounds the provider response body', async () => {
    respond = (res) => res.end('x'.repeat(300_000));
    await expect(new TripoAdapter(config, endpoint).status('task-123')).rejects.toMatchObject({
      details: { reason: 'provider_response_too_large' },
    });
  });
});
