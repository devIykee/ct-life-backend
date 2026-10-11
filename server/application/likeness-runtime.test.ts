import { describe, expect, it } from 'vitest';
import type { Config } from '../shared/config/config.js';
import type { Db } from '../shared/db/pool.js';
import { buildLikenessRuntime } from './likeness-runtime.js';

function config(privateS3: Partial<Config['likeness']['privateS3']>, bucket = 'likeness-private') {
  return {
    appEnv: 'production',
    nodeEnv: 'production',
    s3: { bucketAds: 'ads', accessKey: 'ads-key', secretKey: 'ads-secret' },
    likeness: {
      operatorUserIds: [],
      localDirectory: '',
      privateBucket: bucket,
      privateStorageConfirmed: true,
      referenceManifest: '',
      privateS3: {
        endpoint: 'https://storage.test',
        region: 'auto',
        forcePathStyle: false,
        accessKey: '',
        secretKey: '',
        ...privateS3,
      },
    },
  } as unknown as Config;
}

const db = {} as Db;

describe('likeness runtime private storage', () => {
  it('refuses the ads bucket', async () => {
    await expect(
      buildLikenessRuntime(config({ accessKey: 'k', secretKey: 's' }, 'ads'), db),
    ).rejects.toThrow('dedicated private bucket');
  });

  it('requires bucket-scoped keys', async () => {
    await expect(buildLikenessRuntime(config({}), db)).rejects.toThrow('LIKENESS_S3_ACCESS_KEY');
  });

  it('refuses the ads bucket keys', async () => {
    await expect(
      buildLikenessRuntime(config({ accessKey: 'ads-key', secretKey: 'ads-secret' }), db),
    ).rejects.toThrow('ads bucket credentials');
  });

  it('stays unconfigured until storage is confirmed', async () => {
    const c = config({});
    (c.likeness as { privateStorageConfirmed: boolean }).privateStorageConfirmed = false;
    const runtime = await buildLikenessRuntime(c, db);
    expect(runtime.worker).toBeUndefined();
    expect(runtime.photos).toBeUndefined();
  });
});
