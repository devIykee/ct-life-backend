/** Tripo HTTP adapter, based on current official OpenAPI docs (2026-10-11).
 * This adapter is not wired to public jobs until upload/privacy/payment fulfillment
 * and selected-character conditioning are complete. It never fetches an image URL.
 * This slightly exceeds the soft file-size limit to keep all provider requests
 * behind the same timeout, body bound, credential and ambiguous-submission guard.
 */
import { z } from 'zod';
import { DomainError, ValidationFailedError } from '../domain/errors.js';
import { LIKENESS_MODELS } from '../domain/likeness.js';

const API = 'https://api.tripo3d.ai/v2/openapi';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const Identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const Token = z.string().min(1).max(4096);
const ImageInput = z.strictObject({ token: Token, type: z.enum(['png', 'jpeg']) });
export const TRIPO_REFERENCE_PROMPT_VERSION = 'ctlife-reference-v1';
const SecureUrl = z.url().refine((raw) => {
  const url = new URL(raw);
  const fixture =
    process.env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  return (url.protocol === 'https:' || fixture) && !url.username && !url.password;
});
const Envelope = z.object({ code: z.number().int(), data: z.unknown().optional() });
const Status = z.object({
  task_id: Identifier,
  status: z.enum([
    'queued',
    'running',
    'success',
    'failed',
    'banned',
    'expired',
    'cancelled',
    'unknown',
  ]),
  progress: z.number().min(0).max(100).optional(),
  consumed_credit: z.number().nonnegative().optional(),
  output: z
    .object({
      model: SecureUrl.optional(),
      pbr_model: SecureUrl.optional(),
      rendered_image: SecureUrl.optional(),
      generated_image: SecureUrl.optional(),
      image: SecureUrl.optional(),
      riggable: z.boolean().optional(),
      rig_type: z
        .enum([
          'biped',
          'quadruped',
          'hexapod',
          'octopod',
          'avian',
          'serpentine',
          'aquatic',
          'others',
        ])
        .optional(),
    })
    .optional(),
});

export interface TripoConfig {
  readonly apiKey: string;
  /** A recorded provider end-user integration agreement, not user's photo consent. */
  readonly endUserAgreementConfirmed: boolean;
  /** Separate, explicitly authorized internal evaluation; never enables the public product. */
  readonly authorizedOperatorEvaluation?: boolean;
  readonly timeoutMs?: number;
}

export class TripoRequestError extends DomainError {
  readonly code = 'LIKENESS_UNAVAILABLE';
  /** Expose our stable reason and whether submission requires reconciliation. */
  constructor(
    reason: string,
    readonly submissionUnknown = false,
  ) {
    // Never include upstream bodies, headers, URLs, photos, or credentials.
    super('The character generation provider could not complete this request.', {
      reason,
      submissionUnknown,
    });
    this.httpStatus = 503;
  }
}

export class TripoAdapter {
  private readonly timeoutMs: number;
  /** Fix the production host; accept loopback HTTP only for contract tests. */
  constructor(
    private readonly config: TripoConfig,
    private readonly endpoint = API,
  ) {
    const url = new URL(endpoint);
    // The only alternate network destination is a loopback HTTP fixture in tests.
    const fixture =
      process.env.NODE_ENV === 'test' &&
      ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) &&
      url.protocol === 'http:';
    if (endpoint !== API && !fixture)
      throw new ValidationFailedError({ reason: 'invalid_provider_endpoint' });
    this.timeoutMs = Math.min(30_000, Math.max(25, config.timeoutMs ?? 15_000));
  }

  /** Read available/frozen API credits; this does not submit generation. */
  async balance(): Promise<{ balance: number; frozen: number }> {
    this.requireConfigured();
    const result = z
      .object({ balance: z.number().nonnegative(), frozen: z.number().nonnegative() })
      .safeParse(await this.request('/user/balance', { method: 'GET' }));
    if (!result.success) throw new TripoRequestError('invalid_provider_balance_response');
    return result.data;
  }

  /** Upload already decoded, metadata-stripped private image bytes. No external URL input. */
  async uploadImage(bytes: Uint8Array, type: 'png' | 'jpeg'): Promise<string> {
    this.requireConfigured();
    if (
      !['png', 'jpeg'].includes(type) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_IMAGE_BYTES
    ) {
      throw new ValidationFailedError({ reason: 'invalid_likeness_image' });
    }
    const signature =
      type === 'png'
        ? Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!signature) throw new ValidationFailedError({ reason: 'image_type_mismatch' });
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: `image/${type}` }),
      `source.${type}`,
    );
    const data = await this.request('/upload', { method: 'POST', body: form });
    const parsed = z.object({ image_token: Token }).safeParse(data);
    if (!parsed.success) throw new TripoRequestError('invalid_provider_upload_response', true);
    return parsed.data.image_token;
  }

  /** Prepare a reviewable body/face reference; likeness and body fidelity require user review. */
  async prepareReference(
    modelId: string,
    character: { token: string; type: 'png' | 'jpeg' },
    face: { token: string; type: 'png' | 'jpeg' },
  ): Promise<string> {
    this.requireConfigured();
    const identity = LIKENESS_MODELS.find((model) => model.modelId === modelId);
    if (
      !identity ||
      identity.reason === 'face_covered' ||
      !ImageInput.safeParse(character).success ||
      !ImageInput.safeParse(face).success
    ) {
      throw new ValidationFailedError({ reason: 'invalid_character_reference' });
    }
    const subject =
      identity.mode === 'human'
        ? 'Keep its adult human body, proportions, outfit and art style. Adapt the face, visible skin tone, hair and facial hair toward the adult person in image[2].'
        : 'Keep its species, silhouette, anatomy, outfit and art style. Reinterpret distinctive visible face, hair and facial-hair traits from the adult person in image[2] within that creature anatomy. Do not paste a human head onto it.';
    const prompt = `Use image[1] as the selected character reference. ${subject} One full-body character, centered, front-facing T-pose, separated hands and feet, plain background, no text or extra people.`;
    return this.createTask({
      type: 'generate_image',
      model_version: 'gemini_3.1_flash_image_preview',
      prompt,
      t_pose: true,
      files: [character, face].map((image) => ({ type: image.type, file_token: image.token })),
    });
  }

  /** The image must be a prepared full-body reference, not an unprocessed selfie. */
  async generate(imageToken: string, type: 'png' | 'jpeg', seed: number): Promise<string> {
    this.requireConfigured();
    if (
      !Token.safeParse(imageToken).success ||
      !['png', 'jpeg'].includes(type) ||
      !Number.isSafeInteger(seed) ||
      seed < 0 ||
      seed > 2_147_483_647
    ) {
      throw new ValidationFailedError({ reason: 'invalid_generation_input' });
    }
    return this.createTask({
      type: 'image_to_model',
      model_version: 'v3.1-20260211',
      file: { type, file_token: imageToken },
      model_seed: seed,
      texture_seed: seed,
      texture: true,
      pbr: true,
      texture_alignment: 'original_image',
      texture_quality: 'standard',
      geometry_quality: 'standard',
      smart_low_poly: true,
      face_limit: 6000,
      quad: false,
    });
  }

  /** Request the documented suitability check before paying for a rig. */
  async preRigCheck(modelTaskId: string): Promise<string> {
    this.requireConfigured();
    if (!Identifier.safeParse(modelTaskId).success)
      throw new ValidationFailedError({ reason: 'invalid_provider_task_id' });
    return this.createTask({ type: 'animate_prerigcheck', original_model_task_id: modelTaskId });
  }

  /** Request a biped GLB rig only after a successful biped pre-rig result. */
  async rigHuman(modelTaskId: string): Promise<string> {
    return this.rigWith(modelTaskId, 'v1.0-20240301', 'mixamo');
  }

  /** Request the v2.5 Tripo-spec rig; rejected for humanoids (no usable head/neck branch). */
  async rig(modelTaskId: string): Promise<string> {
    return this.rigWith(modelTaskId, 'v2.5-20260210', 'tripo');
  }

  private async rigWith(modelTaskId: string, version: string, spec: string): Promise<string> {
    this.requireConfigured();
    if (!Identifier.safeParse(modelTaskId).success)
      throw new ValidationFailedError({ reason: 'invalid_provider_task_id' });
    return this.createTask({
      type: 'animate_rig',
      original_model_task_id: modelTaskId,
      model_version: version,
      rig_type: 'biped',
      spec,
      out_format: 'glb',
    });
  }

  /** Read task state without downloading provider output URLs. */
  async status(taskId: string) {
    this.requireConfigured();
    if (!Identifier.safeParse(taskId).success)
      throw new ValidationFailedError({ reason: 'invalid_provider_task_id' });
    const parsed = Status.safeParse(
      await this.request(`/task/${encodeURIComponent(taskId)}`, { method: 'GET' }),
    );
    if (!parsed.success || parsed.data.task_id !== taskId)
      throw new TripoRequestError('invalid_provider_task_response');
    const data = parsed.data;
    return {
      taskId,
      status: data.status,
      stage:
        data.status === 'queued'
          ? 'queued'
          : data.status === 'running'
            ? 'processing'
            : data.status === 'success'
              ? 'succeeded'
              : data.status === 'unknown'
                ? 'unknown'
                : data.status === 'cancelled'
                  ? 'cancelled'
                  : 'failed',
      progress: data.progress ?? 0,
      consumedCredits: data.consumed_credit ?? null,
      // Server-only, short-lived URLs. Download/validation requires a separate
      // host allowlist + size/type controls before assets can enter the game.
      output: data.output ?? {},
    };
  }

  private requireConfigured(): void {
    if (
      !this.config.apiKey.trim() ||
      (!this.config.endUserAgreementConfirmed && !this.config.authorizedOperatorEvaluation)
    ) {
      throw new TripoRequestError('provider_not_configured');
    }
  }

  private async createTask(payload: Record<string, unknown>): Promise<string> {
    const data = await this.request('/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const parsed = z.object({ task_id: Identifier }).safeParse(data);
    if (!parsed.success) throw new TripoRequestError('invalid_provider_task_response', true);
    return parsed.data.task_id;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const mutating = init.method === 'POST';
    try {
      // No automatic retries: a timed-out task POST might already have spent
      // credits. The future worker must reconcile before resubmission.
      const response = await fetch(`${this.endpoint}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { ...init.headers, authorization: `Bearer ${this.config.apiKey}` },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TripoRequestError(
          `provider_http_${response.status}`,
          mutating && response.status >= 500,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new TripoRequestError('empty_provider_response', mutating);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new TripoRequestError('provider_response_too_large', mutating);
        }
        chunks.push(chunk.value);
      }
      const parsed = Envelope.safeParse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      );
      if (!parsed.success) throw new TripoRequestError('invalid_provider_response', mutating);
      if (parsed.data.code !== 0) throw new TripoRequestError('provider_rejected_request');
      return parsed.data.data;
    } catch (error) {
      if (error instanceof TripoRequestError) throw error;
      throw new TripoRequestError('provider_transport_failed', mutating);
    }
  }
}
