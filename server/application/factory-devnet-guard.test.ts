/**
 * Factory launch paths (prepare, confirm, submit) refuse anything but devnet, even when
 * the factory is configured and the deployment would boot on mainnet (security review L4).
 */
import { describe, expect, it } from 'vitest';
import { confirmLaunch, prepareLaunch, submitLaunch } from './factory-real.js';
import type { AppContext } from './context.js';

const mainnet = {
  config: {
    solana: { cluster: 'mainnet' },
    factory: {
      dbcConfig: '11111111111111111111111111111111',
      metadataStore: 'self',
      publicBaseUrl: 'https://api.example',
      pinataJwt: '',
      pinataGateway: '',
    },
  },
  db: {},
} as unknown as AppContext;

const devnetOnly = {
  code: 'CAPABILITY_OFF',
  details: { capability: 'factory', reason: 'devnet_only' },
};

describe('factory launches are devnet only', () => {
  it('prepare, confirm and submit throw CAPABILITY_OFF devnet_only on mainnet', async () => {
    await expect(
      prepareLaunch(mainnet, 'u', {
        name: 'Frog',
        ticker: 'FROG',
        imageBase64: 'AA==',
        riskAccepted: true,
      } as Parameters<typeof prepareLaunch>[2]),
    ).rejects.toMatchObject(devnetOnly);
    await expect(confirmLaunch(mainnet, 'u', 'l', 'sig')).rejects.toMatchObject(devnetOnly);
    await expect(submitLaunch(mainnet, 'u', 'l', 'AA==')).rejects.toMatchObject(devnetOnly);
  });
});
