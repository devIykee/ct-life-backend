/** Decode untrusted photo bytes once; only the re-encoded image may be retained.
 * Sharp 0.35.5: https://sharp.pixelplumbing.com/api-constructor/ and api-output/.
 * No face recognition or provider call occurs here.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { DomainError, ValidationFailedError } from '../domain/errors.js';

export const MAX_LIKENESS_PHOTO_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_LIKENESS_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_EDGE = 4096;
const MAX_PIXELS = 16_000_000;
const OUTPUT_EDGE = 2048;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface NormalizedLikenessPhoto {
  readonly bytes: Buffer;
  readonly contentType: 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

function invalid(reason: string): never {
  throw new ValidationFailedError({ reason });
}

// libvips can decode the first frame of APNG silently. Reject its animation chunks
// before decoding, including one-frame APNG, and require a complete PNG container.
function checkPng(bytes: Buffer): void {
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + 12 + length > bytes.length) invalid('invalid_likeness_image');
    if (offset === 8 && (kind !== 'IHDR' || length !== 13)) invalid('invalid_likeness_image');
    if (['acTL', 'fcTL', 'fdAT'].includes(kind)) invalid('animated_likeness_image');
    offset += 12 + length;
    if (kind === 'IEND') {
      if (length !== 0 || offset !== bytes.length) invalid('invalid_likeness_image');
      ended = true;
      break;
    }
  }
  if (!ended) invalid('invalid_likeness_image');
}

function checkInput(input: Uint8Array, declaredContentType: string): Buffer {
  if (input.byteLength === 0 || input.byteLength > MAX_LIKENESS_PHOTO_INPUT_BYTES)
    invalid('likeness_image_size');
  const bytes = Buffer.from(input);
  if (declaredContentType === 'image/png' && bytes.subarray(0, 8).equals(PNG)) {
    checkPng(bytes);
  } else if (
    declaredContentType === 'image/jpeg' &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  ) {
    // A multi-picture JPEG uses an MPF APP2 segment; accept only one photo.
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1];
      if (marker === 218 || marker === 217) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) invalid('invalid_likeness_image');
      if (marker === 226 && bytes.toString('ascii', offset + 4, offset + 8) === 'MPF\0')
        invalid('animated_likeness_image');
      offset += 2 + length;
    }
  } else invalid('image_type_mismatch');
  return bytes;
}

/** Normalize PNG/JPEG, apply EXIF orientation, discard metadata and bound all dimensions. */
export async function normalizeLikenessPhoto(
  input: Uint8Array,
  declaredContentType: 'image/jpeg' | 'image/png',
): Promise<NormalizedLikenessPhoto> {
  const bytes = checkInput(input, declaredContentType);
  const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS }).timeout({
    seconds: 5,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      decoder.destroy();
      reject(new ValidationFailedError({ reason: 'likeness_image_timeout' }));
    }, 10_000);
  });
  try {
    const operation = async (): Promise<NormalizedLikenessPhoto> => {
      const metadata = await decoder.metadata();
      if (
        !['jpeg', 'png'].includes(metadata.format ?? '') ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > MAX_EDGE ||
        metadata.height > MAX_EDGE ||
        metadata.width * metadata.height > MAX_PIXELS ||
        (metadata.pages ?? 1) !== 1
      )
        invalid('likeness_image_dimensions');
      // Metadata is removed by default: never use keep/withMetadata/withExif here.
      const result = await decoder
        .autoOrient()
        .resize(OUTPUT_EDGE, OUTPUT_EDGE, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .toColourspace('srgb')
        .jpeg({ quality: 88, chromaSubsampling: '4:2:0' })
        .toBuffer({ resolveWithObject: true });
      if (result.data.length === 0 || result.data.length > MAX_LIKENESS_PHOTO_BYTES)
        invalid('likeness_image_size');
      return {
        bytes: result.data,
        contentType: 'image/jpeg',
        width: result.info.width,
        height: result.info.height,
        sha256: createHash('sha256').update(result.data).digest('hex'),
      };
    };
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    // Decoder errors may include embedded metadata; do not propagate their message.
    return invalid('invalid_likeness_image');
  } finally {
    clearTimeout(timer);
    decoder.destroy();
  }
}
