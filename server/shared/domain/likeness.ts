/** Paid likeness boundaries. Payment verification and photo validation are server-only. */
import { DomainError } from './errors.js';

export const LIKENESS_CONSENT_VERSION = 'likeness-v1';
export const LIKENESS_PRODUCT = 'likeness_3d_v1';
export type LikenessMode = 'human' | 'stylized';

export const LIKENESS_MODELS: ReadonlyArray<{
  modelId: string;
  mode: LikenessMode;
  reason: string;
}> = [
  { modelId: 'head_snow', mode: 'human', reason: 'provider_not_configured' },
  { modelId: 'head_rain', mode: 'human', reason: 'provider_not_configured' },
  { modelId: 'head_ubc_m', mode: 'human', reason: 'provider_not_configured' },
  { modelId: 'head_ubc_f', mode: 'human', reason: 'provider_not_configured' },
  { modelId: 'head_pm_shark', mode: 'stylized', reason: 'provider_not_configured' },
  { modelId: 'head_pm_froggy', mode: 'stylized', reason: 'provider_not_configured' },
  { modelId: 'head_hero_assassin', mode: 'human', reason: 'face_covered' },
  { modelId: 'head_hero_gynoid', mode: 'stylized', reason: 'provider_not_configured' },
  { modelId: 'head_hero_hazmat', mode: 'human', reason: 'face_covered' },
  { modelId: 'head_hero_balaclava', mode: 'human', reason: 'face_covered' },
];

export interface LikenessInput {
  readonly modelId: string;
  readonly uploadId: string;
  readonly entitlementId: string;
  readonly consent: {
    readonly version: typeof LIKENESS_CONSENT_VERSION;
    readonly ownPhoto: true;
    readonly shareWithProvider: true;
  };
}

export interface LikenessJob {
  readonly source: 'operator_evaluation' | 'verified_purchase';
  readonly id: string;
  readonly modelId: string;
  readonly mode: LikenessMode;
  readonly status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  readonly phase: string;
  readonly referenceSha256: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LikenessAssetManifest {
  readonly jobId: string;
  readonly modelId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly triangles: number;
  readonly joints: number;
  readonly humanoidBones: Readonly<Record<string, string>>;
  readonly heightMeters: number;
  readonly validatorVersion: string;
}

export class LikenessUnavailableError extends DomainError {
  readonly code = 'LIKENESS_UNAVAILABLE';
  constructor() {
    super('Character likeness is not available yet. No photo or payment was accepted.', {
      reason: 'provider_not_configured',
    });
    this.httpStatus = 503;
  }
}

/** Readiness is deliberately not controlled by an env toggle or a client field. */
export interface LikenessReadiness {
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly models: Readonly<Record<string, LikenessMode>>;
}

export const UNCONFIGURED_LIKENESS: LikenessReadiness = Object.freeze({
  enabled: false,
  provider: null,
  models: Object.freeze({}),
});
