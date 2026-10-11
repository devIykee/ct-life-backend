/** Synthetic 15-joint triangle rig for validation/worker tests; contains no person's likeness. */

/** Serialize two aligned GLB2 chunks for synthetic test fixtures. */
export function encodeGlbFixture(document: unknown, binary: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binLength = Math.ceil(binary.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonLength + binLength);
  bytes.write('glTF', 0, 'ascii');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(32, 20, 20 + jsonLength);
  json.copy(bytes, 20);
  bytes.writeUInt32LE(binLength, 20 + jsonLength);
  bytes.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(bytes, 28 + jsonLength);
  return bytes;
}

/** A static, self-contained indexed mesh weighted to a valid 15-joint hierarchy. */
export function createRiggedGlbFixture(triangleCount = 1, jointCount = 15): Buffer {
  const indexBytes = triangleCount * 6;
  const matrixOffset = 96 + Math.ceil(indexBytes / 4) * 4;
  const binary = Buffer.alloc(matrixOffset + jointCount * 64);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => binary.writeFloatLE(value, i * 4));
  for (let vertex = 0; vertex < 3; vertex++) binary.writeFloatLE(1, 48 + vertex * 16);
  for (let i = 0; i < triangleCount * 3; i++) binary.writeUInt16LE(i % 3, 96 + i * 2);
  for (let joint = 0; joint < jointCount; joint++)
    for (let diagonal = 0; diagonal < 4; diagonal++)
      binary.writeFloatLE(1, matrixOffset + joint * 64 + diagonal * 20);
  const nodes = [
    { mesh: 0, skin: 0 },
    ...Array.from({ length: jointCount }, (_, i) => ({
      name: `joint_${i}`,
      children: i < jointCount - 1 ? [i + 2] : [],
    })),
  ];
  return encodeGlbFixture(
    {
      asset: { version: '2.0', generator: 'CT Life synthetic test fixture' },
      buffers: [{ byteLength: binary.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
        { buffer: 0, byteOffset: 36, byteLength: 12, target: 34962 },
        { buffer: 0, byteOffset: 48, byteLength: 48, target: 34962 },
        { buffer: 0, byteOffset: 96, byteLength: indexBytes, target: 34963 },
        { buffer: 0, byteOffset: matrixOffset, byteLength: jointCount * 64 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
        { bufferView: 3, componentType: 5123, count: triangleCount * 3, type: 'SCALAR' },
        { bufferView: 4, componentType: 5126, count: jointCount, type: 'MAT4' },
      ],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, indices: 3 }] },
      ],
      skins: [
        {
          joints: Array.from({ length: jointCount }, (_, i) => i + 1),
          skeleton: 1,
          inverseBindMatrices: 4,
        },
      ],
      nodes,
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
    },
    binary,
  );
}
