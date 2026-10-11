/** Real loopback HTTP/DNS plus synthetic rig geometry; no provider or external-network calls.
 * The shared protocol/geometry fixtures justify exceeding the 300-line soft limit. */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createSocket, type Socket } from 'node:dgram';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectRiggedGlb,
  LikenessArtifactReader,
  LikenessArtifactTransportError,
} from './likeness-artifacts.js';
import { createRiggedGlbFixture, encodeGlbFixture } from './likeness-fixture.test-helper.js';

function changeGlb(
  change: (doc: Record<string, any>, binary: Buffer) => void,
  input = createRiggedGlbFixture(),
): Buffer {
  const length = input.readUInt32LE(12);
  const doc = JSON.parse(input.toString('utf8', 20, 20 + length)) as Record<string, any>;
  const bin = Buffer.from(input.subarray(28 + length));
  change(doc, bin);
  return encodeGlbFixture(doc, bin);
}

describe('rigged GLB structural and geometry checks', () => {
  it('accepts a complete indexed15-joint synthetic rig with content hash', () => {
    const bytes = createRiggedGlbFixture();
    expect(inspectRiggedGlb(bytes)).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      triangles: 1,
      joints: 15,
    });
  });

  it('accepts the12000triangle budget and rejects12001', () => {
    expect(inspectRiggedGlb(createRiggedGlbFixture(12_000)).triangles).toBe(12_000);
    expect(() => inspectRiggedGlb(createRiggedGlbFixture(12_001))).toThrowError(/validation/);
  });

  it('counts repeated mesh instances against the render budget', () => {
    const bytes = changeGlb((doc) => {
      doc.nodes.push({ mesh: 0, skin: 0 });
      doc.scenes[0].nodes.push(doc.nodes.length - 1);
    }, createRiggedGlbFixture(7000));
    expect(() => inspectRiggedGlb(bytes)).toThrowError(/validation/);
  });

  it.each([
    [
      'hidden skinned mesh',
      (doc: any) => {
        doc.scenes[0].nodes = [1];
      },
    ],
    [
      'hidden joint hierarchy',
      (doc: any) => {
        doc.scenes[0].nodes = [0];
      },
    ],
    [
      'disconnected joints',
      (doc: any) => {
        doc.nodes[1].children = [];
        doc.scenes[0].nodes.push(2);
      },
    ],
    [
      'wrong skeleton root',
      (doc: any) => {
        doc.skins[0].skeleton = 0;
      },
    ],
    [
      'missing vertex bounds',
      (doc: any) => {
        delete doc.accessors[0].min;
      },
    ],
    [
      'wrong normal type',
      (doc: any) => {
        doc.meshes[0].primitives[0].attributes.NORMAL = 1;
      },
    ],
    [
      'wrong texture coordinate type',
      (doc: any) => {
        doc.meshes[0].primitives[0].attributes.TEXCOORD_0 = 0;
      },
    ],
    [
      'wrong index buffer target',
      (doc: any) => {
        doc.bufferViews[3].target = 34962;
      },
    ],
    [
      'external buffer',
      (doc: any) => {
        doc.buffers[0].uri = 'https://example.com/model.bin';
      },
    ],
    [
      'data URI',
      (doc: any) => {
        doc.images = [{ uri: 'data:image/png;base64,eA==' }];
      },
    ],
    [
      'extension URL',
      (doc: any) => {
        doc.extensions = { unknown: { uri: 'https://example.com/' } };
      },
    ],
    [
      'compression extension',
      (doc: any) => {
        doc.extensionsRequired = ['KHR_draco_mesh_compression'];
      },
    ],
    [
      'sparse accessor',
      (doc: any) => {
        doc.accessors[0].sparse = { count: 1 };
      },
    ],
    [
      'animations',
      (doc: any) => {
        doc.animations = [{}];
      },
    ],
    [
      'morph target',
      (doc: any) => {
        doc.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
      },
    ],
    [
      'buffer outside binary',
      (doc: any) => {
        doc.bufferViews[0].byteLength = 999999;
      },
    ],
    [
      'missing buffer view',
      (doc: any) => {
        doc.accessors[0].bufferView = 999;
      },
    ],
    [
      'negative count',
      (doc: any) => {
        doc.accessors[0].count = -3;
      },
    ],
    [
      'attribute count mismatch',
      (doc: any) => {
        doc.accessors[1].count = 2;
      },
    ],
    [
      'misaligned accessor',
      (doc: any) => {
        doc.accessors[0].byteOffset = 1;
      },
    ],
    [
      'undersized stride',
      (doc: any) => {
        doc.bufferViews[0].byteStride = 4;
      },
    ],
    [
      'invalid primitive mode',
      (doc: any) => {
        doc.meshes[0].primitives[0].mode = 1;
      },
    ],
    [
      'invalid indices accessor',
      (doc: any) => {
        doc.meshes[0].primitives[0].indices = 999;
      },
    ],
    [
      'wrong indices type',
      (doc: any) => {
        doc.accessors[3].componentType = 5122;
      },
    ],
    [
      'invalid node mesh',
      (doc: any) => {
        doc.nodes[0].mesh = 999;
      },
    ],
    [
      'invalid node skin',
      (doc: any) => {
        doc.nodes[0].skin = 999;
      },
    ],
    [
      'missing rig',
      (doc: any) => {
        delete doc.nodes[0].skin;
      },
    ],
    [
      'missing joint',
      (doc: any) => {
        doc.skins[0].joints[0] = 999;
      },
    ],
    [
      'duplicate joints',
      (doc: any) => {
        doc.skins[0].joints[0] = 2;
      },
    ],
    [
      'bad inverse bind matrices',
      (doc: any) => {
        doc.skins[0].inverseBindMatrices = 0;
      },
    ],
    [
      'graph cycle',
      (doc: any) => {
        doc.nodes[15].children = [1];
      },
    ],
    [
      'multiple node parents',
      (doc: any) => {
        doc.nodes[0].children = [2];
      },
    ],
    [
      'bad scene root',
      (doc: any) => {
        doc.scenes[0].nodes = [999];
      },
    ],
    [
      'wrong skin weights type',
      (doc: any) => {
        doc.accessors[2].type = 'VEC3';
      },
    ],
    [
      'image and vertex range alias',
      (doc: any) => {
        doc.images = [{ bufferView: 0, mimeType: 'image/png' }];
      },
    ],
    [
      'texture missing image',
      (doc: any) => {
        doc.textures = [{ source: 0 }];
      },
    ],
  ] as const)('rejects %s using typed domain errors', (_name, change) => {
    const bytes = changeGlb(change);
    expect(() => inspectRiggedGlb(bytes)).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
        details: { reason: 'invalid_or_unsupported_generated_glb' },
      }),
    );
  });

  it('bounds repeated accessor work even when ranges alias a small binary', () => {
    const bytes = changeGlb((doc) => {
      // Aliased accessor declarations cannot amplify into unlimited validation loops.
      const matrices = doc.accessors[4];
      doc.accessors = [...doc.accessors, ...Array.from({ length: 4091 }, () => ({ ...matrices }))];
      // 4096 * 15 *16 <2M, so expand the aliased source range to its allowed maximum.
      const count = Math.floor(doc.buffers[0].byteLength / 64);
      doc.bufferViews[4] = { buffer: 0, byteOffset: 0, byteLength: doc.buffers[0].byteLength };
      doc.accessors.slice(5).forEach((accessor: any) => {
        accessor.count = count;
      });
    }, createRiggedGlbFixture(12000));
    expect(() => inspectRiggedGlb(bytes)).toThrowError(/validation/);
  });

  it.each([
    ['out-of-bounds index', (binary: Buffer) => binary.writeUInt16LE(3, 96)],
    ['NaN vertex', (binary: Buffer) => binary.writeFloatLE(NaN, 0)],
    ['infinite weight', (binary: Buffer) => binary.writeFloatLE(Infinity, 48)],
    ['negative weight', (binary: Buffer) => binary.writeFloatLE(-1, 48)],
    ['zero weights', (binary: Buffer) => binary.writeFloatLE(0, 48)],
    ['invalid joint reference', (binary: Buffer) => binary.writeUInt8(15, 36)],
  ] as const)('rejects binary %s', (_name, change) => {
    expect(() => inspectRiggedGlb(changeGlb((_doc, binary) => change(binary)))).toThrowError(
      /validation/,
    );
  });

  it('rejects malformed containers and arbitrary JSON shapes without raw exceptions', () => {
    const valid = createRiggedGlbFixture();
    const cases = [
      Buffer.alloc(0),
      Buffer.alloc(32 * 1024 * 1024 + 1),
      valid.subarray(0, valid.length - 1),
      encodeGlbFixture(null, Buffer.alloc(4)),
      encodeGlbFixture([], Buffer.alloc(4)),
      changeGlb((doc) => {
        doc.buffers = [null];
      }),
      changeGlb((doc) => {
        doc.meshes = 'wrong';
      }),
    ];
    const brokenLength = Buffer.from(valid);
    brokenLength.writeUInt32LE(0xffffffff, 12);
    cases.push(brokenLength);
    const badUtf8 = Buffer.from(valid);
    badUtf8[20] = 255;
    cases.push(badUtf8);
    for (const bytes of cases)
      expect(() => inspectRiggedGlb(bytes)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
  });
});

describe('provider artifact HTTP boundary', () => {
  let server: Server;
  let base: string;
  let reader: LikenessArtifactReader;
  let requests: string[] = [];
  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      switch (request.url) {
        case '/ok':
          response.end('fixture');
          return;
        case '/redirect':
          response.writeHead(302, { location: `${base}/ok` });
          response.end();
          return;
        case '/oversized':
          response.writeHead(200, { 'content-length': 99999 });
          response.write('x');
          return;
        case '/chunked':
          response.write('one');
          response.end('twothree');
          return;
        case '/compressed':
          response.writeHead(200, { 'content-encoding': 'gzip' });
          response.end('x');
          return;
        case '/truncated':
          response.writeHead(200, { 'content-length': 8 });
          response.end('partial');
          return;
        case '/unavailable':
          response.writeHead(503);
          response.end('upstream details');
          return;
        case '/limited':
          response.writeHead(429);
          response.end('upstream details');
          return;
        case '/missing':
          response.writeHead(404);
          response.end('upstream details');
          return;
        case '/reset':
          request.socket.destroy();
          return;
        case '/hang-headers':
          return;
        case '/hang-body':
          response.write('x');
          return;
        default:
          response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture bind failed');
    base = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    requests = [];
    reader = new LikenessArtifactReader(['127.0.0.1'], 100);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('downloads only the exact approved URL and bytes', async () => {
    expect(await reader.read(`${base}/ok`, 7)).toEqual(Buffer.from('fixture'));
    expect(requests).toEqual(['/ok']);
  });
  it.each(['/redirect', '/oversized', '/chunked', '/compressed', '/empty', '/missing'])(
    'rejects %s with a bounded failure',
    async (path) => {
      await expect(reader.read(`${base}${path}`, 8)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect(requests).toEqual([path]);
    },
  );
  it.each(['/truncated', '/hang-headers', '/hang-body', '/unavailable', '/limited', '/reset'])(
    'classifies %s as a retryable read without exposing upstream details',
    async (path) => {
      const result = reader.read(`${base}${path}`, 8);
      await expect(result).rejects.toBeInstanceOf(LikenessArtifactTransportError);
      await expect(result).rejects.toMatchObject({
        code: 'LIKENESS_UNAVAILABLE',
        httpStatus: 503,
        message: 'The generated character artifact could not be downloaded yet.',
      });
      expect(requests).toEqual([path]);
    },
  );
  it('rejects unapproved URLs and unsafe limits before opening a socket', async () => {
    for (const url of [
      'not a url',
      `${base}/ok#hash`,
      base.replace('127.0.0.1', 'localhost'),
      base.replace('127.0.0.1', '127.0.0.1.evil.test'),
      base.replace('http://', 'http://user:password@'),
      'file:///tmp/file',
    ])
      await expect(reader.read(url, 20)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    for (const max of [NaN, Infinity, 1.5, 0, -1, 32 * 1024 * 1024 + 1])
      await expect(reader.read(`${base}/ok`, max)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    expect(requests).toEqual([]);
  });
  it('never permits loopback HTTP or custom DNS outside tests', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(reader.read(`${base}/ok`, 20)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(() => new LikenessArtifactReader(['example.com'], 100, ['127.0.0.1'])).toThrow();
    expect(requests).toEqual([]);
  });
  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '192.168.1.2',
    '100.64.0.1',
    '224.0.0.1',
    '192.88.99.1',
  ])('rejects allowlisted but nonpublic IP %s', async (host) => {
    await expect(
      new LikenessArtifactReader([host]).read(`https://${host}/file`, 20),
    ).rejects.toMatchObject({ details: { reason: 'private_provider_artifact_address' } });
  });
});

describe('provider artifact DNS boundary using a real UDP resolver fixture', () => {
  let server: Socket;
  let endpoint: string;
  let mode: 'private' | 'mixed' | 'v6private' | 'hang' | 'missing' = 'private';
  let queries = 0;
  beforeAll(async () => {
    server = createSocket('udp4');
    server.on('message', (query, remote) => {
      queries++;
      if (mode === 'hang') return;
      let offset = 12;
      while (query[offset] !== 0) offset += 1 + query[offset]!;
      const type = query.readUInt16BE(offset + 1);
      const question = query.subarray(12, offset + 5);
      const addresses =
        type === 1
          ? mode === 'mixed'
            ? [Buffer.from([8, 8, 8, 8]), Buffer.from([127, 0, 0, 1])]
            : mode === 'v6private' || mode === 'missing'
              ? []
              : [Buffer.from([127, 0, 0, 1])]
          : mode === 'v6private'
            ? [Buffer.from('00000000000000000000000000000001', 'hex')]
            : [];
      const header = Buffer.alloc(12);
      query.copy(header, 0, 0, 2);
      header.writeUInt16BE(0x8180, 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(addresses.length, 6);
      const answers = addresses.map((address) => {
        const answer = Buffer.alloc(12 + address.length);
        answer.writeUInt16BE(0xc00c);
        answer.writeUInt16BE(type, 2);
        answer.writeUInt16BE(1, 4);
        answer.writeUInt32BE(1, 6);
        answer.writeUInt16BE(address.length, 10);
        address.copy(answer, 12);
        return answer;
      });
      server.send(Buffer.concat([header, question, ...answers]), remote.port, remote.address);
    });
    await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
    endpoint = `127.0.0.1:${server.address().port}`;
  });
  beforeEach(() => {
    queries = 0;
    mode = 'private';
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(resolve));
  });

  it.each(['private', 'mixed', 'v6private'] as const)(
    'rejects %s address answers before HTTPS connection',
    async (selected) => {
      mode = selected;
      const reader = new LikenessArtifactReader(['fixture.example.test'], 200, [endpoint]);
      await expect(reader.read('https://fixture.example.test/file', 1024)).rejects.toMatchObject({
        details: { reason: 'private_provider_artifact_address' },
      });
      expect(queries).toBe(2);
    },
  );
  it('cancels a stalled DNS lookup within the whole-operation deadline', async () => {
    mode = 'hang';
    const start = Date.now();
    const reader = new LikenessArtifactReader(['fixture.example.test'], 75, [endpoint]);
    await expect(reader.read('https://fixture.example.test/file', 1024)).rejects.toMatchObject({
      code: 'LIKENESS_UNAVAILABLE',
    });
    expect(queries).toBeGreaterThan(0);
    expect(Date.now() - start).toBeLessThan(1000);
  });
  it('treats missing DNS records as a retryable resolution failure', async () => {
    mode = 'missing';
    const reader = new LikenessArtifactReader(['fixture.example.test'], 200, [endpoint]);
    await expect(reader.read('https://fixture.example.test/file', 1024)).rejects.toMatchObject({
      code: 'LIKENESS_UNAVAILABLE',
      details: { reason: 'provider_artifact_dns_failed' },
    });
    expect(queries).toBe(2);
  });
});
