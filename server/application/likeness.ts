/** Authenticated likeness availability and durable entitlement consumption. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ValidationFailedError } from '../shared/domain/errors.js';
import {
  LIKENESS_CONSENT_VERSION,
  LIKENESS_MODELS,
  LikenessUnavailableError,
  UNCONFIGURED_LIKENESS,
  type LikenessReadiness,
  type LikenessJob,
} from '../shared/domain/likeness.js';
import type { LikenessRepository } from '../shared/db/likeness.js';

const Input = z.strictObject({
  modelId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  uploadId: z.uuid(),
  entitlementId: z.uuid(),
  consent: z.strictObject({
    version: z.literal(LIKENESS_CONSENT_VERSION),
    ownPhoto: z.literal(true),
    shareWithProvider: z.literal(true),
  }),
});

export class LikenessService {
  /** Production defaults to unavailable; tests inject a ready boundary. */
  constructor(
    private readonly repository: LikenessRepository,
    private readonly readiness: LikenessReadiness = UNCONFIGURED_LIKENESS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Return the offering without accepting photos or payment. */
  availability() {
    // Production composition intentionally uses UNCONFIGURED_LIKENESS. An API
    // key alone does not implement paid fulfillment, private uploads, or rig QA.
    const enabled = this.readiness.enabled && Boolean(this.readiness.provider);
    return {
      enabled,
      reason: enabled ? null : 'provider_not_configured',
      provider: this.readiness.provider,
      photoUploadEnabled: false,
      price: null,
      modes: ['human', 'stylized'],
      consentVersion: LIKENESS_CONSENT_VERSION,
      supportedModels: LIKENESS_MODELS.map((model) => {
        const supported =
          enabled &&
          model.reason !== 'face_covered' &&
          this.readiness.models[model.modelId] === model.mode;
        return { ...model, enabled: supported, reason: supported ? null : model.reason };
      }),
    };
  }

  /** Validate explicit consent and reserve one owned paid generation job. */
  async create(userId: string, key: unknown, rawInput: unknown): Promise<LikenessJob> {
    if (typeof key !== 'string' || !z.uuid().safeParse(key).success) {
      throw new ValidationFailedError({ reason: 'idempotency_key_must_be_uuid' });
    }
    const parsed = Input.safeParse(rawInput);
    if (!parsed.success) throw new ValidationFailedError({ reason: 'invalid_likeness_request' });
    this.requireAvailable();
    const identity = LIKENESS_MODELS.find((model) => model.modelId === parsed.data.modelId);
    if (!identity || identity.reason === 'face_covered') {
      throw new ValidationFailedError({ reason: 'unsupported_likeness_model' });
    }
    const mode = this.readiness.models[parsed.data.modelId];
    if (!mode || mode !== identity.mode)
      throw new ValidationFailedError({ reason: 'unsupported_likeness_model' });
    const hash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    return this.repository.create({
      userId,
      id: randomUUID(),
      key,
      hash,
      input: parsed.data,
      mode,
      provider: this.readiness.provider!,
      now: this.now(),
    });
  }

  /** Read an owned job even while new generation is switched off. */
  async get(userId: string, id: string): Promise<LikenessJob> {
    if (!z.uuid().safeParse(id).success)
      throw new ValidationFailedError({ reason: 'invalid_likeness_job_id' });
    return this.repository.get(userId, id);
  }

  private requireAvailable(): void {
    if (!this.readiness.enabled || !this.readiness.provider) throw new LikenessUnavailableError();
  }
}
