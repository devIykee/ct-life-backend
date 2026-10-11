/** Fail-closed artifact transport and the supported GLB2 subset, based on Khronos glTF2.
 * This file exceeds the soft size limit to keep untrusted URL/binary validation together.
 * Structural acceptance is followed by separate Unity rig, texture and motion QA.
 */
import { Resolver } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ValidationFailedError } from '../domain/errors.js';

const MAX_BYTES = 32 * 1024 * 1024;
const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(ip, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const invalid = (reason = 'invalid_or_unsupported_generated_glb') =>
  new ValidationFailedError({ reason });

export class LikenessArtifactTransportError extends DomainError {
  readonly code = 'LIKENESS_UNAVAILABLE';
  /** Retryable read failure, with no upstream URLs, credentials, or response bodies. */
  constructor(reason: string) {
    super('The generated character artifact could not be downloaded yet.', { reason });
    this.httpStatus = 503;
  }
}

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Allow global unicast only; reject mapped IPv4, NAT64, local, multicast and tunnels.
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export class LikenessArtifactReader {
  private readonly hosts: ReadonlySet<string>;
  /** Hosts are reviewed deployment configuration, never client input. DNS override is test-only. */
  constructor(
    allowedHosts: readonly string[],
    private readonly timeoutMs = 15_000,
    private readonly testDnsServers?: readonly string[],
  ) {
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 25 ||
      timeoutMs > 30_000 ||
      allowedHosts.some(
        (host) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..'),
      ) ||
      (testDnsServers !== undefined && process.env.NODE_ENV !== 'test')
    )
      throw invalid('invalid_artifact_reader_config');
    this.hosts = new Set(allowedHosts);
  }

  /** One whole-operation deadline includes DNS; HTTPS keeps its original Host/SNI with a pinned IP. */
  async read(rawUrl: string, maxBytes: number): Promise<Buffer> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw invalid('unapproved_provider_artifact_url');
    }
    const fixture =
      process.env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if (
      rawUrl.length > 8192 ||
      !this.hosts.has(url.hostname) ||
      url.username ||
      url.password ||
      url.hash ||
      (!fixture && (url.protocol !== 'https:' || (url.port && url.port !== '443'))) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_BYTES
    )
      throw invalid('unapproved_provider_artifact_url');
    const resolver = new Resolver({ timeout: this.timeoutMs, tries: 1 });
    if (this.testDnsServers) resolver.setServers([...this.testDnsServers]);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        resolver.cancel();
        abort.abort();
        reject(new LikenessArtifactTransportError('provider_artifact_timeout'));
      }, this.timeoutMs);
    });
    try {
      const operation = async () => {
        let addresses: string[];
        if (isIP(url.hostname)) addresses = [url.hostname];
        else {
          const results = await Promise.allSettled([
            resolver.resolve4(url.hostname),
            resolver.resolve6(url.hostname),
          ]);
          // NODATA for one family is normal; SERVFAIL/timeouts must not hide other unsafe answers.
          if (
            results.some(
              (result) =>
                result.status === 'rejected' &&
                !['ENODATA', 'ENOTFOUND'].includes((result.reason as { code?: string }).code ?? ''),
            )
          )
            throw new LikenessArtifactTransportError('provider_artifact_dns_failed');
          addresses = results.flatMap((result) =>
            result.status === 'fulfilled' ? result.value : [],
          );
        }
        if (!addresses.length)
          throw new LikenessArtifactTransportError('provider_artifact_dns_failed');
        if (!fixture && addresses.some((address) => !publicAddress(address)))
          throw invalid('private_provider_artifact_address');
        abort.signal.throwIfAborted();
        return this.download(url, addresses[0]!, maxBytes, fixture, abort.signal);
      };
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new LikenessArtifactTransportError('provider_artifact_download_failed');
    } finally {
      clearTimeout(timer);
      resolver.cancel();
    }
  }

  private download(
    url: URL,
    address: string,
    maxBytes: number,
    fixture: boolean,
    signal: AbortSignal,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const fail = () =>
        reject(new LikenessArtifactTransportError('provider_artifact_download_failed'));
      const request = fixture ? httpRequest : httpsRequest;
      const req = request(
        url,
        {
          method: 'GET',
          agent: false,
          signal,
          maxHeaderSize: 16 * 1024,
          headers: { 'accept-encoding': 'identity' },
          family: isIP(address),
          lookup: (_host, _options, callback) => callback(null, address, isIP(address)),
        },
        (res) => {
          const lengthHeader = res.headers['content-length'];
          const length = lengthHeader === undefined ? undefined : Number(lengthHeader);
          if (
            res.statusCode === 429 ||
            (res.statusCode !== undefined && res.statusCode >= 500 && res.statusCode <= 599)
          ) {
            reject(new LikenessArtifactTransportError('provider_artifact_http_unavailable'));
            res.destroy();
            return;
          }
          if (
            res.statusCode !== 200 ||
            (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') ||
            (length !== undefined &&
              (!Number.isSafeInteger(length) || length < 1 || length > maxBytes))
          ) {
            reject(invalid('invalid_provider_artifact_response'));
            res.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              reject(invalid('provider_artifact_too_large'));
              res.destroy();
            } else chunks.push(chunk);
          });
          res.on('error', fail);
          res.on('aborted', fail);
          res.on('end', () => {
            if (!res.complete || (length !== undefined && total !== length)) fail();
            else if (total === 0) reject(invalid('empty_provider_artifact'));
            else resolve(Buffer.concat(chunks, total));
          });
        },
      );
      req.on('error', fail);
      req.end();
    });
  }
}

const index = z.number().int().min(0).max(65_535);
const finite = z.number().finite();
const accessorSchema = z.object({
  bufferView: index,
  byteOffset: z.number().int().min(0).max(MAX_BYTES).default(0),
  componentType: z.union([
    z.literal(5120),
    z.literal(5121),
    z.literal(5122),
    z.literal(5123),
    z.literal(5125),
    z.literal(5126),
  ]),
  count: z.number().int().min(1).max(36_000),
  type: z.enum(['SCALAR', 'VEC2', 'VEC3', 'VEC4', 'MAT4']),
  normalized: z.boolean().default(false),
  sparse: z.never().optional(),
  min: z.array(finite).max(16).optional(),
  max: z.array(finite).max(16).optional(),
});
const primitiveSchema = z.object({
  mode: z.literal(4).default(4),
  indices: index.optional(),
  attributes: z.record(z.string(), index),
  material: index.optional(),
  targets: z.never().optional(),
});
const documentSchema = z.object({
  asset: z.object({ version: z.literal('2.0'), minVersion: z.literal('2.0').optional() }),
  buffers: z
    .array(
      z.object({ byteLength: z.number().int().min(1).max(MAX_BYTES), uri: z.never().optional() }),
    )
    .length(1),
  bufferViews: z
    .array(
      z.object({
        buffer: z.literal(0),
        byteOffset: z.number().int().min(0).max(MAX_BYTES).default(0),
        byteLength: z.number().int().min(1).max(MAX_BYTES),
        byteStride: z.number().int().min(4).max(252).multipleOf(4).optional(),
        target: z.union([z.literal(34962), z.literal(34963)]).optional(),
      }),
    )
    .min(1)
    .max(4096),
  accessors: z.array(accessorSchema).min(1).max(4096),
  images: z
    .array(
      z.object({
        bufferView: index,
        mimeType: z.enum(['image/jpeg', 'image/png']),
        uri: z.never().optional(),
      }),
    )
    .max(16)
    .default([]),
  textures: z
    .array(z.object({ source: index, sampler: index.optional() }))
    .max(32)
    .default([]),
  samplers: z.array(z.object({})).max(32).default([]),
  materials: z.array(z.object({})).max(64).default([]),
  nodes: z
    .array(
      z.object({
        skin: index.optional(),
        mesh: index.optional(),
        children: z.array(index).max(512).default([]),
        matrix: z.array(finite).length(16).optional(),
        translation: z.array(finite).length(3).optional(),
        rotation: z.array(finite).length(4).optional(),
        scale: z.array(finite).length(3).optional(),
      }),
    )
    .min(1)
    .max(512),
  skins: z
    .array(
      z.object({
        joints: z.array(index).min(1).max(150),
        skeleton: index.optional(),
        inverseBindMatrices: index.optional(),
      }),
    )
    .min(1)
    .max(16),
  meshes: z
    .array(
      z.object({
        primitives: z.array(primitiveSchema).min(1).max(128),
        weights: z.never().optional(),
      }),
    )
    .min(1)
    .max(64),
  scenes: z
    .array(z.object({ nodes: z.array(index).min(1).max(512) }))
    .min(1)
    .max(16),
  scene: index.default(0),
  animations: z.array(z.unknown()).length(0).optional(),
  extensionsUsed: z.array(z.string()).length(0).optional(),
  extensionsRequired: z.array(z.string()).length(0).optional(),
});
type GlbDocument = z.infer<typeof documentSchema>;
type Accessor = z.infer<typeof accessorSchema> & {
  offset: number;
  stride: number;
  size: number;
  components: number;
};

function rejectExternal(value: unknown, depth = 0): void {
  if (depth > 64) throw invalid();
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'uri' ||
      (key === 'extensions' &&
        (typeof child !== 'object' || child === null || Object.keys(child).length))
    )
      throw invalid();
    rejectExternal(child, depth + 1);
  }
}

function readGlb(bytes: Buffer): { doc: GlbDocument; bin: Buffer } {
  if (
    bytes.length < 28 ||
    bytes.length > MAX_BYTES ||
    bytes.toString('ascii', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw invalid();
  const jsonLength = bytes.readUInt32LE(12);
  const binOffset = 20 + jsonLength;
  if (
    jsonLength < 4 ||
    jsonLength % 4 !== 0 ||
    jsonLength > 2 * 1024 * 1024 ||
    binOffset + 8 > bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a ||
    bytes.readUInt32LE(binOffset + 4) !== 0x004e4942
  )
    throw invalid();
  const binLength = bytes.readUInt32LE(binOffset);
  if (binLength % 4 !== 0 || binOffset + 8 + binLength !== bytes.length) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, binOffset)),
    ) as unknown;
  } catch {
    throw invalid();
  }
  rejectExternal(parsed);
  const result = documentSchema.safeParse(parsed);
  if (!result.success) throw invalid();
  const doc = result.data;
  const length = doc.buffers[0]!.byteLength;
  if (
    length > binLength ||
    binLength - length > 3 ||
    bytes.subarray(binOffset + 8 + length).some((byte) => byte !== 0)
  )
    throw invalid();
  return { doc, bin: bytes.subarray(binOffset + 8, binOffset + 8 + length) };
}

function readComponent(
  bin: Buffer,
  accessor: Accessor,
  element: number,
  component: number,
): number {
  const offset = accessor.offset + element * accessor.stride + component * accessor.size;
  switch (accessor.componentType) {
    case 5120:
      return bin.readInt8(offset);
    case 5121:
      return bin.readUInt8(offset);
    case 5122:
      return bin.readInt16LE(offset);
    case 5123:
      return bin.readUInt16LE(offset);
    case 5125:
      return bin.readUInt32LE(offset);
    case 5126:
      return bin.readFloatLE(offset);
  }
}

function accessors(doc: GlbDocument, bin: Buffer): Accessor[] {
  // Aliased accessor ranges must not multiply a small binary into unbounded CPU work.
  let scalarCount = 0;
  for (const view of doc.bufferViews)
    if (
      view.byteOffset + view.byteLength > bin.length ||
      (view.byteStride !== undefined && view.byteStride > view.byteLength)
    )
      throw invalid();
  return doc.accessors.map((source) => {
    const view = doc.bufferViews[source.bufferView];
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[source.componentType];
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[source.type];
    scalarCount += source.count * components;
    if (scalarCount > 2_000_000) throw invalid();
    if (
      !view ||
      source.byteOffset % size !== 0 ||
      view.byteOffset % size !== 0 ||
      (source.normalized && [5125, 5126].includes(source.componentType))
    )
      throw invalid();
    const stride = view.byteStride ?? size * components;
    if (
      stride < size * components ||
      source.byteOffset + (source.count - 1) * stride + size * components > view.byteLength
    )
      throw invalid();
    if (
      (source.min && source.min.length !== components) ||
      (source.max && source.max.length !== components)
    )
      throw invalid();
    const result = {
      ...source,
      offset: view.byteOffset + source.byteOffset,
      stride,
      size,
      components,
    };
    if (source.componentType === 5126)
      for (let i = 0; i < source.count; i++)
        for (let c = 0; c < components; c++)
          if (!Number.isFinite(readComponent(bin, result, i, c))) throw invalid();
    return result;
  });
}

function inspectGraph(doc: GlbDocument): number {
  const parents = new Map<number, number>();
  doc.nodes.forEach((node, i) => {
    if (
      (node.mesh !== undefined && !doc.meshes[node.mesh]) ||
      (node.skin !== undefined && (!doc.skins[node.skin] || node.mesh === undefined)) ||
      (node.matrix && (node.translation || node.rotation || node.scale))
    )
      throw invalid();
    for (const child of node.children) {
      if (!doc.nodes[child] || child === i || parents.has(child)) throw invalid();
      parents.set(child, i);
    }
  });
  for (let i = 0; i < doc.nodes.length; i++) {
    const seen = new Set<number>();
    let ancestor: number | undefined = i;
    while (ancestor !== undefined) {
      if (seen.has(ancestor)) throw invalid();
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
  }
  if (!doc.scenes[doc.scene]) throw invalid();
  for (const scene of doc.scenes)
    if (
      new Set(scene.nodes).size !== scene.nodes.length ||
      scene.nodes.some((node) => !doc.nodes[node] || parents.has(node))
    )
      throw invalid();
  const jointIds = new Set<number>();
  const rootOf = (node: number): number => {
    while (parents.has(node)) node = parents.get(node)!;
    return node;
  };
  const visibleRoots = new Set(doc.scenes[doc.scene]!.nodes);
  doc.nodes.forEach((node, i) => {
    if (node.skin !== undefined && !visibleRoots.has(rootOf(i))) throw invalid();
  });
  for (const skin of doc.skins) {
    if (
      new Set(skin.joints).size !== skin.joints.length ||
      skin.joints.some((joint) => !doc.nodes[joint]) ||
      (skin.skeleton !== undefined && !doc.nodes[skin.skeleton])
    )
      throw invalid();
    if (
      new Set(skin.joints.map(rootOf)).size !== 1 ||
      skin.joints.some((joint) => !visibleRoots.has(rootOf(joint)))
    )
      throw invalid();
    if (skin.skeleton !== undefined)
      for (const joint of skin.joints) {
        let ancestor: number | undefined = joint;
        while (ancestor !== undefined && ancestor !== skin.skeleton)
          ancestor = parents.get(ancestor);
        if (ancestor === undefined) throw invalid();
      }
    skin.joints.forEach((joint) => jointIds.add(joint));
  }
  if (jointIds.size < 15 || jointIds.size > 150) throw invalid();
  return jointIds.size;
}

function inspectSkin(doc: GlbDocument, data: Accessor[], bin: Buffer): void {
  let skinned = false;
  let vertices = 0;
  const inspected = new Set<string>();
  for (const node of doc.nodes) {
    if (node.skin === undefined || node.mesh === undefined) continue;
    skinned = true;
    const pair = `${node.skin}:${node.mesh}`;
    if (inspected.has(pair)) continue;
    inspected.add(pair);
    const skin = doc.skins[node.skin]!;
    if (skin.inverseBindMatrices !== undefined) {
      const matrix = data[skin.inverseBindMatrices];
      if (
        !matrix ||
        matrix.type !== 'MAT4' ||
        matrix.componentType !== 5126 ||
        matrix.count !== skin.joints.length
      )
        throw invalid();
    }
    for (const primitive of doc.meshes[node.mesh]!.primitives) {
      const joints = data[primitive.attributes['JOINTS_0'] ?? -1];
      const weights = data[primitive.attributes['WEIGHTS_0'] ?? -1];
      if (
        !joints ||
        !weights ||
        joints.type !== 'VEC4' ||
        weights.type !== 'VEC4' ||
        ![5121, 5123].includes(joints.componentType) ||
        joints.normalized ||
        ![5121, 5123, 5126].includes(weights.componentType) ||
        (weights.componentType !== 5126 && !weights.normalized) ||
        Object.keys(primitive.attributes).some(
          (key) => /^(JOINTS|WEIGHTS)_/.test(key) && !key.endsWith('_0'),
        )
      )
        throw invalid();
      vertices += joints.count;
      if (vertices > 100_000) throw invalid();
      const divisor =
        weights.componentType === 5121 ? 255 : weights.componentType === 5123 ? 65535 : 1;
      for (let vertex = 0; vertex < joints.count; vertex++) {
        let sum = 0;
        const used = new Set<number>();
        for (let component = 0; component < 4; component++) {
          const joint = readComponent(bin, joints, vertex, component);
          const weight = readComponent(bin, weights, vertex, component) / divisor;
          if (
            joint >= skin.joints.length ||
            weight < 0 ||
            weight > 1 ||
            (weight > 0 && used.has(joint))
          )
            throw invalid();
          if (weight > 0) used.add(joint);
          sum += weight;
        }
        if (Math.abs(sum - 1) > 0.001) throw invalid();
      }
    }
  }
  if (!skinned) throw invalid();
}

function inspectAttribute(name: string, accessor: Accessor): void {
  const float = accessor.componentType === 5126;
  const unit = float || ([5121, 5123].includes(accessor.componentType) && accessor.normalized);
  const valid =
    name === 'POSITION' || name === 'NORMAL'
      ? accessor.type === 'VEC3' && float
      : name === 'TANGENT'
        ? accessor.type === 'VEC4' && float
        : /^TEXCOORD_\d+$/.test(name)
          ? accessor.type === 'VEC2' && unit
          : /^COLOR_\d+$/.test(name)
            ? ['VEC3', 'VEC4'].includes(accessor.type) && unit
            : name === 'JOINTS_0'
              ? accessor.type === 'VEC4' &&
                [5121, 5123].includes(accessor.componentType) &&
                !accessor.normalized
              : name === 'WEIGHTS_0'
                ? accessor.type === 'VEC4' && unit
                : name.startsWith('_') && accessor.type !== 'MAT4';
  if (!valid || accessor.offset % 4 !== 0 || accessor.stride % 4 !== 0) throw invalid();
}

/** Supported static triangle rig only; no external resources, compression, sparse data or animations. */
export function inspectRiggedGlb(bytes: Buffer): {
  sha256: string;
  triangles: number;
  joints: number;
} {
  const { doc, bin } = readGlb(bytes);
  const data = accessors(doc, bin);
  const joints = inspectGraph(doc);
  let triangleBudget = 0;
  const meshTriangles = doc.meshes.map((mesh) =>
    mesh.primitives.reduce((sum, primitive) => {
      const position = data[primitive.attributes['POSITION'] ?? -1];
      if (
        !position ||
        position.type !== 'VEC3' ||
        position.componentType !== 5126 ||
        !position.min ||
        !position.max ||
        position.min.some((value, i) => value > position.max![i]!) ||
        (primitive.material !== undefined && !doc.materials[primitive.material])
      )
        throw invalid();
      for (const [name, attribute] of Object.entries(primitive.attributes)) {
        if (
          !data[attribute] ||
          data[attribute]!.count !== position.count ||
          doc.bufferViews[data[attribute]!.bufferView]!.target === 34963
        )
          throw invalid();
        inspectAttribute(name, data[attribute]!);
      }
      const indices = primitive.indices === undefined ? undefined : data[primitive.indices];
      if (
        primitive.indices !== undefined &&
        (!indices ||
          indices.type !== 'SCALAR' ||
          ![5121, 5123, 5125].includes(indices.componentType) ||
          indices.normalized ||
          doc.bufferViews[indices.bufferView]!.target === 34962 ||
          doc.bufferViews[indices.bufferView]!.byteStride !== undefined)
      )
        throw invalid();
      const count = indices?.count ?? position.count;
      if (count % 3 !== 0) throw invalid();
      triangleBudget += count / 3;
      if (triangleBudget > 12_000) throw invalid();
      if (indices)
        for (let i = 0; i < indices.count; i++)
          if (readComponent(bin, indices, i, 0) >= position.count) throw invalid();
      return sum + count / 3;
    }, 0),
  );
  const triangles = meshTriangles.reduce((sum, count) => sum + count, 0);
  const instanced = doc.nodes.reduce(
    (sum, node) => sum + (node.mesh === undefined ? 0 : meshTriangles[node.mesh]!),
    0,
  );
  if (triangles < 1 || triangles > 12_000 || instanced < 1 || instanced > 12_000) throw invalid();
  inspectSkin(doc, data, bin);
  for (const image of doc.images) {
    const view = doc.bufferViews[image.bufferView];
    if (
      !view ||
      view.byteStride !== undefined ||
      view.target !== undefined ||
      view.byteLength > 8 * 1024 * 1024 ||
      doc.accessors.some((accessor) => accessor.bufferView === image.bufferView)
    )
      throw invalid();
    const bytes = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    const signature =
      image.mimeType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!signature) throw invalid();
  }
  for (const texture of doc.textures)
    if (
      !doc.images[texture.source] ||
      (texture.sampler !== undefined && !doc.samplers[texture.sampler])
    )
      throw invalid();
  return { sha256: createHash('sha256').update(bytes).digest('hex'), triangles, joints };
}
