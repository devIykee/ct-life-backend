/** Synthetic pixels only; no personal photos or provider calls. */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_LIKENESS_PHOTO_INPUT_BYTES, normalizeLikenessPhoto } from './likeness-image.js';

const image = (width = 64, height = 32) =>
  sharp({
    create: { width, height, channels: 4, background: { r: 44, g: 88, b: 132, alpha: 0.75 } },
  });

// Valid PNG ancillary chunk; animation detection must not depend on decoder errors.
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

describe('private likeness photo normalization', () => {
  it.each(['png', 'jpeg'] as const)(
    'decodes real %s pixels and produces bounded JPEG + content hash',
    async (format) => {
      const input = await image().toFormat(format).toBuffer();
      const result = await normalizeLikenessPhoto(input, `image/${format}`);
      const metadata = await sharp(result.bytes).metadata();
      expect(result.contentType).toBe('image/jpeg');
      expect(metadata).toMatchObject({ format: 'jpeg', width: 64, height: 32, channels: 3 });
      expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'));
      expect(result.bytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    },
  );

  it('applies EXIF orientation and strips EXIF, GPS/author metadata, ICC and XMP', async () => {
    const input = await image(80, 40)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Artist: 'Synthetic test author' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '1/1 2/1 3/1' },
      })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">Synthetic test metadata</x:xmpmeta>')
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const result = await normalizeLikenessPhoto(input, 'image/jpeg');
    expect(result).toMatchObject({ width: 40, height: 80 });
    const metadata = await sharp(result.bytes).metadata();
    for (const field of ['exif', 'icc', 'xmp', 'iptc', 'orientation'] as const)
      expect(metadata[field]).toBeUndefined();
    expect(result.bytes.includes(Buffer.from('Synthetic test'))).toBe(false);
  });

  it('downsizes without changing aspect ratio or enlarging small photos', async () => {
    const large = await normalizeLikenessPhoto(
      await image(4096, 2048).png().toBuffer(),
      'image/png',
    );
    expect(large).toMatchObject({ width: 2048, height: 1024 });
    const small = await normalizeLikenessPhoto(await image(12, 20).png().toBuffer(), 'image/png');
    expect(small).toMatchObject({ width: 12, height: 20 });
  });

  it('flattens transparent pixels over white', async () => {
    const input = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#00000000' },
    })
      .png()
      .toBuffer();
    const result = await normalizeLikenessPhoto(input, 'image/png');
    const pixels = await sharp(result.bytes).raw().toBuffer();
    expect([...pixels]).toEqual(Array(12).fill(255));
  });

  it.each([
    [4097, 8],
    [8, 4097],
    [4096, 4096],
  ])('rejects decoded dimensions %sx%s', async (width, height) => {
    const input = await image(width, height).png().toBuffer();
    await expect(normalizeLikenessPhoto(input, 'image/png')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects empty and oversized input before decoding', async () => {
    for (const input of [Buffer.alloc(0), Buffer.alloc(MAX_LIKENESS_PHOTO_INPUT_BYTES + 1)])
      await expect(normalizeLikenessPhoto(input, 'image/jpeg')).rejects.toMatchObject({
        details: { reason: 'likeness_image_size' },
      });
  });

  it('rejects mismatched MIME, SVG, GIF, WebP and arbitrary bytes', async () => {
    const unsupported = [
      await image().png().toBuffer(),
      await image().gif().toBuffer(),
      await image().webp().toBuffer(),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('not an image'),
    ];
    for (const input of unsupported)
      await expect(normalizeLikenessPhoto(input, 'image/jpeg')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
  });

  it.each(['png', 'jpeg'] as const)(
    'rejects truncated %s containers and pixel data',
    async (format) => {
      const input = await image().toFormat(format).toBuffer();
      await expect(
        normalizeLikenessPhoto(input.subarray(0, input.length - 15), `image/${format}`),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const malformed =
        format === 'jpeg'
          ? Buffer.concat([
              input.subarray(0, Math.floor(input.length / 2)),
              Buffer.from([255, 217]),
            ])
          : Buffer.concat([input.subarray(0, 45), input.subarray(input.length - 12)]);
      await expect(normalizeLikenessPhoto(malformed, `image/${format}`)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    },
  );

  it.each([1, 2])('rejects valid PNG animation control with %s frames', async (frames) => {
    const input = await image().png().toBuffer();
    const data = Buffer.alloc(8);
    data.writeUInt32BE(frames);
    const animated = Buffer.concat([
      input.subarray(0, 33),
      pngChunk('acTL', data),
      input.subarray(33),
    ]);
    await expect(normalizeLikenessPhoto(animated, 'image/png')).rejects.toMatchObject({
      details: { reason: 'animated_likeness_image' },
    });
  });

  it('rejects PNG trailers and multipicture JPEG markers', async () => {
    const png = await image().png().toBuffer();
    await expect(
      normalizeLikenessPhoto(Buffer.concat([png, Buffer.from('trailer')]), 'image/png'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const jpeg = await image().jpeg().toBuffer();
    const marker = Buffer.from([255, 226, 0, 6, 77, 80, 70, 0]);
    await expect(
      normalizeLikenessPhoto(
        Buffer.concat([jpeg.subarray(0, 2), marker, jpeg.subarray(2)]),
        'image/jpeg',
      ),
    ).rejects.toMatchObject({ details: { reason: 'animated_likeness_image' } });
  });
});
