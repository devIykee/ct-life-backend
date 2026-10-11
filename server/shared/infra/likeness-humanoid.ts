/** Bounded server validation for the supported Mixamo humanoid GLB subset.
 * This does not replace the client's Avatar.isHuman and animation checks.
 */
import sharp from 'sharp';
import { inspectRiggedGlb } from './likeness-artifacts.js';
import { ValidationFailedError } from '../domain/errors.js';
import type { LikenessAssetManifest } from '../domain/likeness.js';

const boneNames: Readonly<Record<string, string>> = {
  Hips: 'Hips',
  Spine: 'Spine',
  Chest: 'Spine1',
  UpperChest: 'Spine2',
  Neck: 'Neck',
  Head: 'Head',
  LeftShoulder: 'LeftShoulder',
  LeftUpperArm: 'LeftArm',
  LeftLowerArm: 'LeftForeArm',
  LeftHand: 'LeftHand',
  RightShoulder: 'RightShoulder',
  RightUpperArm: 'RightArm',
  RightLowerArm: 'RightForeArm',
  RightHand: 'RightHand',
  LeftUpperLeg: 'LeftUpLeg',
  LeftLowerLeg: 'LeftLeg',
  LeftFoot: 'LeftFoot',
  LeftToes: 'LeftToeBase',
  RightUpperLeg: 'RightUpLeg',
  RightLowerLeg: 'RightLeg',
  RightFoot: 'RightFoot',
  RightToes: 'RightToeBase',
};
type Node = {
  name?: string;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
};
type Document = {
  nodes: Node[];
  skins: Array<{ joints: number[] }>;
  images?: Array<{ bufferView: number; mimeType: string }>;
  bufferViews: Array<{ byteOffset?: number; byteLength: number }>;
  materials?: Array<Record<string, unknown>>;
};
const invalid = (reason: string) => new ValidationFailedError({ reason });

function worldPosition(nodes: Node[], parents: Map<number, number>, index: number): number[] {
  let point = [0, 0, 0],
    cursor: number | undefined = index;
  while (cursor !== undefined) {
    const node = nodes[cursor]!;
    if (node.matrix) {
      const m = node.matrix,
        [x, y, z] = point as [number, number, number];
      point = [
        m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
        m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
        m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
      ];
    } else {
      const [x, y, z] = point.map((v, i) => v * (node.scale?.[i] ?? 1)) as [number, number, number];
      const [qx, qy, qz, qw] = (node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number];
      if (Math.abs(qx * qx + qy * qy + qz * qz + qw * qw - 1) > 0.001)
        throw invalid('invalid_humanoid_rotation');
      const tx = 2 * (qy * z - qz * y),
        ty = 2 * (qz * x - qx * z),
        tz = 2 * (qx * y - qy * x);
      point = [
        x + qw * tx + qy * tz - qz * ty,
        y + qw * ty + qz * tx - qx * tz,
        z + qw * tz + qx * ty - qy * tx,
      ].map((v, i) => v + (node.translation?.[i] ?? 0));
    }
    cursor = parents.get(cursor);
  }
  if (point.some((v) => !Number.isFinite(v) || Math.abs(v) > 100))
    throw invalid('invalid_humanoid_position');
  return point;
}

/** Inspect bounded binary/texture data and the supported upright humanoid bone hierarchy. */
export async function validateLikenessHumanoid(
  bytes: Buffer,
  jobId: string,
  modelId: string,
): Promise<LikenessAssetManifest> {
  if (bytes.length > 16 * 1024 * 1024) throw invalid('humanoid_asset_too_large');
  const inspected = inspectRiggedGlb(bytes);
  const jsonLength = bytes.readUInt32LE(12),
    bin = bytes.subarray(jsonLength + 28);
  const doc = JSON.parse(bytes.toString('utf8', 20, jsonLength + 20)) as Document;
  const parents = new Map<number, number>();
  doc.nodes.forEach((n, i) => n.children?.forEach((child) => parents.set(child, i)));
  const joints = new Set(doc.skins.flatMap((s) => s.joints));
  const indices: Record<string, number> = {},
    humanoidBones: Record<string, string> = {};
  for (const [human, name] of Object.entries(boneNames)) {
    const candidates = doc.nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n, i }) => joints.has(i) && n.name === `mixamorig:${name}`);
    if (candidates.length !== 1) throw invalid('missing_or_ambiguous_humanoid_bone');
    indices[human] = candidates[0]!.i;
    humanoidBones[human] = candidates[0]!.n.name!;
  }
  const chains = [
    ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head'],
    ...['Left', 'Right'].flatMap((side) => [
      [`UpperChest`, `${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`, `${side}Hand`],
      ['Hips', `${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`, `${side}Toes`],
    ]),
  ];
  for (const chain of chains)
    for (let i = 1; i < chain.length; i++) {
      let cursor = parents.get(indices[chain[i]!]!);
      while (cursor !== undefined && cursor !== indices[chain[i - 1]!])
        cursor = parents.get(cursor);
      if (cursor === undefined) throw invalid('invalid_humanoid_hierarchy');
    }
  const position = (name: string) => worldPosition(doc.nodes, parents, indices[name]!);
  const hips = position('Hips'),
    head = position('Head'),
    left = position('LeftFoot'),
    right = position('RightFoot');
  const height = head[1]! - Math.min(left[1]!, right[1]!);
  if (
    height < 0.4 ||
    height > 3 ||
    head[1]! <= hips[1]! ||
    hips[1]! <= Math.max(left[1]!, right[1]!) ||
    Math.abs(head[0]! - hips[0]!) > height * 0.25 ||
    Math.abs(head[2]! - hips[2]!) > height * 0.25
  )
    throw invalid('invalid_humanoid_proportions');
  let pixels = 0;
  for (const image of doc.images ?? []) {
    const view = doc.bufferViews[image.bufferView]!,
      offset = view.byteOffset ?? 0;
    const data = bin.subarray(offset, offset + view.byteLength);
    try {
      const decoder = sharp(data, { limitInputPixels: 2048 * 2048, failOn: 'warning' });
      const metadata = await decoder.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width > 2048 ||
        metadata.height > 2048 ||
        (metadata.pages ?? 1) !== 1
      )
        throw invalid('invalid_humanoid_texture');
      pixels += metadata.width * metadata.height;
      if (pixels > 16 * 1024 * 1024) throw invalid('humanoid_texture_budget_exceeded');
      await decoder.raw().toBuffer();
    } catch {
      throw invalid('invalid_humanoid_texture');
    }
  }
  return {
    jobId,
    modelId,
    ...inspected,
    bytes: bytes.length,
    humanoidBones,
    heightMeters: 1.75,
    validatorVersion: 'ctlife-human-glb-v1',
  };
}
