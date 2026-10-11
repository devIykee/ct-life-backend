/**
 * Config loader.
 *
 * Reads typed configuration from process.env (and the gitignored
 * `.env` file via dotenv). All other modules import `config` from
 * here — no module reads `process.env` directly except this one.
 *
 * Layering: this is the only place environment variables are parsed.
 * Transport (api/realtime/workers) and domain code consume the typed
 * `Config` object. Domain code MUST NOT reach into `process.env` even
 * through this module: it is an application concern.
 *
 * The env var names mirror those in `.env.example` (the M0 contract).
 * devnet / mainnet are split for cluster-specific values
 * (TREASURY_PUBKEY_DEVNET, SETTLE_AUTHORITY_KEYPAIR_DEVNET, etc.); we
 * pick the cluster from `APP_ENV` (local → devnet, prod → mainnet)
 * and expose the resolved value as `Config.solana.treasuryPubkey` etc.
 *
 * Rules:
 *
 *   - Every required variable throws on startup with a clear message
 *     naming the variable and the env it expects. The smoke and
 *     dev:up scripts run before the API, so a missing variable fails
 *     fast.
 *   - Optional variables default to a documented value.
 *   - No secrets are logged.
 */
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';

loadDotenv();

export type AppEnv = 'local' | 'staging' | 'prod';

export interface Config {
  readonly likeness: {
    readonly priceUsdcCents: number;
    readonly generationEnabled: boolean;
    readonly endUserAgreementConfirmed: boolean;
    readonly operatorEvaluationEnabled: boolean;
    readonly operatorUserIds: readonly string[];
    readonly runtimeProfileConfirmed: boolean;
    readonly privateStorageConfirmed: boolean;
    readonly apiKey: string;
    readonly localDirectory: string;
    readonly privateBucket: string;
    /** Bucket-scoped keys for the private bucket; never the ads bucket keys. */
    readonly privateS3: {
      readonly endpoint: string;
      readonly region: string;
      readonly forcePathStyle: boolean;
      readonly accessKey: string;
      readonly secretKey: string;
    };
    readonly referenceManifest: string;
  };
  readonly appEnv: AppEnv;
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

  readonly databaseUrl: string;
  readonly redisUrl: string;

  readonly jwt: {
    readonly privateKeyPem: string;
    readonly publicKeyPem: string;
    readonly issuer: string;
    readonly audience: string;
    readonly accessTtlSec: number;
    readonly refreshTtlSec: number;
    readonly kid: string;
  };

  readonly siws: {
    readonly domain: string;
    readonly uri: string;
  };

  readonly solana: {
    readonly cluster: 'devnet' | 'mainnet';
    readonly rpcUrl: string;
    readonly treasuryPubkey: string;
    readonly settleAuthorityKey: string;
    readonly adminKey: string;
  };

  readonly helius: {
    readonly apiKey: string;
    readonly rpcUrlDevnet: string;
    readonly rpcUrlMainnet: string;
    readonly webhookSecret: string;
  };

  readonly livekit: {
    readonly url: string;
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly webhookSecret: string;
  };

  readonly s3: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKey: string;
    readonly secretKey: string;
    readonly bucketAds: string;
    readonly forcePathStyle: boolean;
  };

  readonly auth: {
    readonly devAuthEnabled: boolean;
    readonly adminWallets: readonly string[];
  };

  readonly rateLimits: {
    readonly restPerUserPerSec: number;
    readonly restGlobalPerSec: number;
    readonly loginPerIpPerMin: number;
    readonly loginGlobalConcurrent: number;
  };

  readonly features: {
    readonly llmEnabled: boolean;
    readonly pushEnabled: boolean;
    readonly xLinkEnabled: boolean;
    readonly mainnetTests: boolean;
    /** Read the ORE board from mainnet (read-only). ORE_READER_ENABLED. */
    readonly oreReader: boolean;
  };

  readonly llmModel: string;
  readonly anthropicApiKey: string;

  readonly xLink: {
    readonly enabled: boolean;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly authorizeUrl: string;
    readonly tokenUrl: string;
    readonly meUrl: string;
  };
}

class ConfigError extends Error {
  constructor(name: string, hint: string) {
    super(`Missing or invalid env var ${name}. ${hint}`);
    this.name = 'ConfigError';
  }
}

function requireEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new ConfigError(name, hint);
  return v;
}

function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function asInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new ConfigError(name, 'expected an integer');
  return n;
}

function asBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function parseAppEnv(raw: string | undefined): AppEnv {
  if (raw === 'local' || raw === 'staging' || raw === 'prod') return raw;
  throw new ConfigError('APP_ENV', 'expected one of: local, staging, prod');
}

function parseLogLevel(raw: string | undefined): Config['logLevel'] {
  switch (raw) {
    case 'fatal':
    case 'error':
    case 'warn':
    case 'info':
    case 'debug':
    case 'trace':
    case undefined:
      return raw ?? 'info';
    default:
      throw new ConfigError('LOG_LEVEL', 'expected one of: fatal, error, warn, info, debug, trace');
  }
}

function resolvePEM(value: string): string {
  // The M0 contract stores the JWT key as a path; we read it here
  // so the rest of the code sees a PEM string. An empty value means
  // "not configured" — used for the public key when only the
  // private key is supplied.
  if (value === '') return '';
  if (value.includes('-----BEGIN')) return value;
  try {
    return readFileSync(value, 'utf8');
  } catch (e) {
    throw new ConfigError('JWT key path', `could not read ${value}: ${(e as Error).message}`);
  }
}

let cached: Config | null = null;

/**
 * Read `process.env` and return the typed `Config`. Throws on a
 * missing required variable. Memoised; subsequent calls return the
 * same object. The transport layer calls this once at composition.
 */
export function loadConfig(): Config {
  if (cached !== null) return cached;

  const appEnv = parseAppEnv(process.env.APP_ENV);
  const nodeEnv =
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test'
      ? process.env.NODE_ENV
      : 'development';

  const cluster: 'devnet' | 'mainnet' = appEnv === 'prod' ? 'mainnet' : 'devnet';

  // Dev auth is only safe when APP_ENV=local or APP_ENV=mock.
  // Hard-fail at startup if enabled in staging/prod or when NODE_ENV=production.
  const devAuthEnabled = asBool('ENABLE_DEV_AUTH', appEnv === 'local' && nodeEnv === 'development');

  if (devAuthEnabled) {
    if (appEnv === 'staging' || appEnv === 'prod') {
      throw new Error(
        'FATAL: ENABLE_DEV_AUTH=true is not allowed when APP_ENV is staging or prod. ' +
          'Dev auth bypasses signature verification and must only run in local or mock environments.',
      );
    }
    if (nodeEnv === 'production') {
      throw new Error(
        'FATAL: ENABLE_DEV_AUTH=true is not allowed when NODE_ENV=production. ' +
          'Dev auth bypasses signature verification and must only run in development.',
      );
    }
  }

  const cfg: Config = {
    likeness: {
      priceUsdcCents: asInt('LIKENESS_PRICE_USDC_CENTS', 300),
      generationEnabled: asBool('LIKENESS_GENERATION_ENABLED', false),
      endUserAgreementConfirmed: asBool('TRIPO_END_USER_AGREEMENT_CONFIRMED', false),
      operatorEvaluationEnabled: asBool('LIKENESS_OPERATOR_EVALUATION_ENABLED', false),
      operatorUserIds: optionalEnv('LIKENESS_OPERATOR_USER_IDS', '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      runtimeProfileConfirmed: asBool('LIKENESS_RUNTIME_PROFILE_CONFIRMED', false),
      privateStorageConfirmed: asBool('LIKENESS_PRIVATE_STORAGE_CONFIRMED', false),
      apiKey: optionalEnv('TRIPO_API_KEY', ''),
      localDirectory: optionalEnv('LIKENESS_LOCAL_DIRECTORY', ''),
      privateBucket: optionalEnv('LIKENESS_PRIVATE_BUCKET', ''),
      privateS3: {
        endpoint: optionalEnv(
          'LIKENESS_S3_ENDPOINT',
          optionalEnv('S3_ENDPOINT', 'http://localhost:9000'),
        ),
        region: optionalEnv('LIKENESS_S3_REGION', optionalEnv('S3_REGION', 'us-east-1')),
        forcePathStyle: asBool('LIKENESS_S3_FORCE_PATH_STYLE', asBool('S3_FORCE_PATH_STYLE', true)),
        accessKey: optionalEnv('LIKENESS_S3_ACCESS_KEY', ''),
        secretKey: optionalEnv('LIKENESS_S3_SECRET_KEY', ''),
      },
      referenceManifest: optionalEnv('LIKENESS_REFERENCE_MANIFEST', ''),
    },
    appEnv,
    nodeEnv,
    port: asInt('PORT', asInt('PORT_API', appEnv === 'local' ? 4010 : 8080)),
    logLevel: parseLogLevel(process.env.LOG_LEVEL),

    databaseUrl: requireEnv('DATABASE_URL', 'Postgres connection string'),
    redisUrl: requireEnv('REDIS_URL', 'Redis connection string'),

    jwt: {
      privateKeyPem: resolvePEM(
        requireEnv('JWT_PRIVATE_KEY', 'PEM string or path to the RS256 private key file'),
      ),
      publicKeyPem: resolvePEM(optionalEnv('JWT_PUBLIC_KEY', '')),
      issuer: optionalEnv('JWT_ISSUER', 'ct-life'),
      audience: optionalEnv('JWT_AUDIENCE', 'ct-life'),
      accessTtlSec: asInt('JWT_ACCESS_TTL_SEC', asInt('JWT_ACCESS_TTL_SECONDS', 15 * 60)),
      refreshTtlSec: asInt(
        'JWT_REFRESH_TTL_SEC',
        asInt('JWT_REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60),
      ),
      kid: optionalEnv('JWT_KID', optionalEnv('JWT_KEY_ID', 'ct-life-1')),
    },

    siws: {
      // The real domain. verifySignedMessage compares the SIWS message's
      // domain and URI to these exactly, so the Unity client's MWA
      // identity (EnvConfig.AppIdentityUri) must be the same string or
      // every sign-in is rejected. Override per environment if the client
      // needs a transition window.
      domain: optionalEnv('SIWS_DOMAIN', 'ctlife.fun'),
      uri: optionalEnv('SIWS_URI', 'https://ctlife.fun/'),
    },

    solana: {
      cluster,
      rpcUrl: requireEnv(
        cluster === 'mainnet' ? 'HELIUS_RPC_URL_MAINNET' : 'HELIUS_RPC_URL_DEVNET',
        'Solana RPC URL (Helius or local validator)',
      ),
      treasuryPubkey: requireEnv(
        cluster === 'mainnet' ? 'TREASURY_PUBKEY_MAINNET' : 'TREASURY_PUBKEY_DEVNET',
        'treasury public key (base58)',
      ),
      settleAuthorityKey: requireEnv(
        cluster === 'mainnet'
          ? 'SETTLE_AUTHORITY_KEYPAIR_MAINNET'
          : 'SETTLE_AUTHORITY_KEYPAIR_DEVNET',
        'path or base58 of settle authority keypair',
      ),
      adminKey: requireEnv(
        cluster === 'mainnet' ? 'ADMIN_KEYPAIR_MAINNET' : 'ADMIN_KEYPAIR_DEVNET',
        'path or base58 of admin keypair',
      ),
    },

    helius: {
      apiKey: requireEnv('HELIUS_API_KEY', 'Helius API key'),
      rpcUrlDevnet: requireEnv('HELIUS_RPC_URL_DEVNET', 'Helius devnet RPC URL'),
      rpcUrlMainnet: requireEnv('HELIUS_RPC_URL_MAINNET', 'Helius mainnet RPC URL'),
      webhookSecret: requireEnv('HELIUS_WEBHOOK_SECRET', 'Helius webhook signing secret'),
    },

    livekit: {
      url: requireEnv('LIVEKIT_URL', 'LiveKit URL, ws://…'),
      apiKey: requireEnv('LIVEKIT_API_KEY', 'LiveKit API key'),
      apiSecret: requireEnv('LIVEKIT_API_SECRET', 'LiveKit API secret'),
      webhookSecret: optionalEnv('LIVEKIT_WEBHOOK_SECRET', 'dev-only-livekit-webhook-secret'),
    },

    s3: {
      endpoint: optionalEnv('S3_ENDPOINT', 'http://localhost:9000'),
      region: optionalEnv('S3_REGION', 'us-east-1'),
      accessKey: requireEnv('S3_ACCESS_KEY', 'S3 access key (MinIO root or staging key)'),
      secretKey: requireEnv('S3_SECRET_KEY', 'S3 secret key'),
      bucketAds: optionalEnv('S3_BUCKET_ADS', 'ct-life-ads'),
      forcePathStyle: asBool('S3_FORCE_PATH_STYLE', true),
    },

    auth: {
      devAuthEnabled,
      adminWallets: optionalEnv('ADMIN_WALLETS', '')
        .split(',')
        .map((w) => w.trim())
        .filter((w) => w.length > 0),
    },

    rateLimits: {
      restPerUserPerSec: asInt('RATE_LIMIT_REST_PER_USER_PER_SEC', 20),
      restGlobalPerSec: asInt('RATE_LIMIT_REST_GLOBAL_PER_SEC', 5_000),
      loginPerIpPerMin: asInt('RATE_LIMIT_LOGIN_PER_IP_PER_MIN', 30),
      loginGlobalConcurrent: asInt('RATE_LIMIT_LOGIN_GLOBAL_CONCURRENT', 200),
    },

    features: {
      llmEnabled: asBool('LLM_ENABLED', false),
      pushEnabled: asBool('PUSH_ENABLED', false),
      xLinkEnabled: asBool('X_LINK_ENABLED', false),
      mainnetTests: asBool('RUN_MAINNET_TESTS', false),
      oreReader: asBool('ORE_READER_ENABLED', false),
    },

    llmModel: process.env.LLM_MODEL ?? 'claude-opus-4-6',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',

    xLink: {
      enabled: asBool('X_LINK_ENABLED', false),
      clientId: process.env.X_CLIENT_ID ?? '',
      clientSecret: process.env.X_CLIENT_SECRET ?? '',
      redirectUri: process.env.X_REDIRECT_URI ?? 'http://localhost:4010/v1/x/link/callback',
      authorizeUrl: process.env.X_AUTHORIZE_URL ?? 'https://x.com/i/oauth2/authorize',
      tokenUrl: process.env.X_TOKEN_URL ?? 'https://api.x.com/2/oauth2/token',
      meUrl: process.env.X_ME_URL ?? 'https://api.x.com/2/users/me',
    },
  };

  cached = cfg;
  return cfg;
}

/** Test-only: clear the cache so a test can mutate env and reload. */
export function _resetConfigForTests(): void {
  cached = null;
}
