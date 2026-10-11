/** Synthetic typed joint trees catch malformed playable profiles, without personal photos. */
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { describe, it, expect } from 'vitest';
import { validateLikenessHumanoid } from './likeness-humanoid.js';
import { createRiggedGlbFixture, encodeGlbFixture } from './likeness-fixture.test-helper.js';
function fixture() {
  const bytes = createRiggedGlbFixture(1, 23),
    length = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  const binary = bytes.subarray(length + 28);
  const bones: [string, string | undefined, number[]][] = [
    ['Root', undefined, [0, 0, 0]],
    ['Hips', 'Root', [0, 1, 0]],
    ['Spine', 'Hips', [0, 0.1, 0]],
    ['Spine1', 'Spine', [0, 0.1, 0]],
    ['Spine2', 'Spine1', [0, 0.15, 0]],
    ['Neck', 'Spine2', [0, 0.1, 0]],
    ['Head', 'Neck', [0, 0.1, 0]],
  ];
  for (const side of ['Left', 'Right']) {
    const sign = side === 'Left' ? 1 : -1;
    bones.push(
      [`${side}Shoulder`, 'Spine2', [sign * 0.1, 0, 0]],
      [`${side}Arm`, `${side}Shoulder`, [sign * 0.15, 0, 0]],
      [`${side}ForeArm`, `${side}Arm`, [sign * 0.25, 0, 0]],
      [`${side}Hand`, `${side}ForeArm`, [sign * 0.25, 0, 0]],
      [`${side}UpLeg`, 'Hips', [sign * 0.1, -0.1, 0]],
      [`${side}Leg`, `${side}UpLeg`, [0, -0.4, 0]],
      [`${side}Foot`, `${side}Leg`, [0, -0.4, 0]],
      [`${side}ToeBase`, `${side}Foot`, [0, 0, 0.15]],
    );
  }
  doc.nodes = [
    { mesh: 0, skin: 0 },
    ...bones.map(([name, , translation]) => ({
      name: name === 'Root' ? name : `mixamorig:${name}`,
      children: [],
      translation,
    })),
  ];
  bones.forEach(([, parent], i) => {
    if (parent) doc.nodes[bones.findIndex((b) => b[0] === parent) + 1].children.push(i + 1);
  });
  return { doc, binary, encode: () => encodeGlbFixture(doc, binary) };
}
describe('humanoid artifact validation', () => {
  it('derives a fixed Mixamo mapping from the validated hierarchy', async () => {
    const f = fixture(),
      id = randomUUID(),
      manifest = await validateLikenessHumanoid(f.encode(), id, 'head_snow');
    expect(manifest).toMatchObject({
      jobId: id,
      modelId: 'head_snow',
      joints: 23,
      heightMeters: 1.75,
      humanoidBones: { Head: 'mixamorig:Head' },
    });
  });
  it('rejects the old arbitrary 15-joint chain', async () => {
    await expect(
      validateLikenessHumanoid(createRiggedGlbFixture(), randomUUID(), 'head_snow'),
    ).rejects.toMatchObject({ details: { reason: 'missing_or_ambiguous_humanoid_bone' } });
  });
  it('rejects a named head attached beneath an arm', async () => {
    const f = fixture(),
      nodes = f.doc.nodes,
      head = nodes.findIndex((n: { name: string }) => n.name === 'mixamorig:Head');
    nodes.find((n: { name: string }) => n.name === 'mixamorig:Neck').children = [];
    nodes.find((n: { name: string }) => n.name === 'mixamorig:LeftArm').children.push(head);
    await expect(
      validateLikenessHumanoid(f.encode(), randomUUID(), 'head_snow'),
    ).rejects.toMatchObject({ details: { reason: 'invalid_humanoid_hierarchy' } });
  });
  it('rejects a properly named head at foot height', async () => {
    const f = fixture();
    f.doc.nodes.find((n: { name: string }) => n.name === 'mixamorig:Head').translation = [
      0, -1.5, 0,
    ];
    await expect(
      validateLikenessHumanoid(f.encode(), randomUUID(), 'head_snow'),
    ).rejects.toMatchObject({ details: { reason: 'invalid_humanoid_proportions' } });
  });
  it('fully decodes embedded images and rejects texture dimensions over the mobile budget', async () => {
    const f = fixture(),
      image = await sharp({
        create: { width: 2049, height: 2, channels: 3, background: '#444444' },
      })
        .png()
        .toBuffer();
    f.doc.images = [{ bufferView: f.doc.bufferViews.length, mimeType: 'image/png' }];
    f.doc.bufferViews.push({ buffer: 0, byteOffset: f.binary.length, byteLength: image.length });
    const binary = Buffer.concat([f.binary, image]);
    f.doc.buffers[0].byteLength = binary.length;
    await expect(
      validateLikenessHumanoid(encodeGlbFixture(f.doc, binary), randomUUID(), 'head_snow'),
    ).rejects.toMatchObject({ details: { reason: 'invalid_humanoid_texture' } });
  });
  it('rejects oversized model bytes before JSON processing', async () => {
    await expect(
      validateLikenessHumanoid(Buffer.alloc(16 * 1024 * 1024 + 1), randomUUID(), 'head_snow'),
    ).rejects.toMatchObject({ details: { reason: 'humanoid_asset_too_large' } });
  });
});
