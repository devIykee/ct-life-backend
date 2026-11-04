import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import {
  createNearFullAccessVerifier,
  createWalletLinkMessage,
  normalizeWalletLinkAddress,
  serializeNep413,
  verifyWalletLinkProof,
  walletLinkProofScheme,
  type WalletLinkChallenge,
  type WalletLinkNetwork,
} from './wallet-links-proofs.js';

const evm = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const ed = generateKeyPairSync('ed25519');
const edAddress = new PublicKey(
  ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
).toBase58();
function challenge(network: WalletLinkNetwork, address: string): WalletLinkChallenge {
  const fields = {
    id: '019a0000-0000-7000-8000-000000000001',
    userId: '019a0000-0000-7000-8000-000000000002',
    network,
    address,
    proofScheme: walletLinkProofScheme(network),
    nonce: 'ab'.repeat(32),
    domain: 'play.ctlife.fun',
    uri: 'https://play.ctlife.fun/',
    origin: 'https://play.ctlife.fun',
    issuedAt: '2026-11-04T00:00:00.000Z',
    expiresAt: '2026-11-04T00:05:00.000Z',
  };
  return { ...fields, message: createWalletLinkMessage(fields) };
}

describe('wallet link standardized identity proofs', () => {
  it('verifies EIP-4361 over EIP-191 and binds player, chain and purpose', async () => {
    const c = challenge('eip155:4663', evm.address.toLowerCase());
    const signature = await evm.signMessage({ message: c.message });
    expect(await verifyWalletLinkProof(c, { signature })).toBe(true);
    expect(c.message).toContain('Chain ID: 4663');
    expect(c.message).toContain(`urn:ctlife:player:${c.userId}`);
    expect(c.message).toContain('does not authorize payments');
    expect(
      await verifyWalletLinkProof({ ...c, message: c.message.replace('4663', '1') }, { signature }),
    ).toBe(false);
    expect(await verifyWalletLinkProof(c, { signature: '0xdeadbeef' })).toBe(false);
    expect(await verifyWalletLinkProof(c, { signature, publicKey: 'unexpected' })).toBe(false);
  });

  it('verifies exact Solana bytes and rejects another key and malformed base64', async () => {
    const c = challenge('solana:mainnet', edAddress);
    const signature = sign(null, Buffer.from(c.message), ed.privateKey).toString('base64');
    expect(await verifyWalletLinkProof(c, { signature })).toBe(true);
    expect(await verifyWalletLinkProof({ ...c, message: `${c.message} ` }, { signature })).toBe(
      false,
    );
    expect(await verifyWalletLinkProof(c, { signature: `${signature}\n` })).toBe(false);
    const other = generateKeyPairSync('ed25519');
    expect(
      await verifyWalletLinkProof(c, {
        signature: sign(null, Buffer.from(c.message), other.privateKey).toString('base64'),
      }),
    ).toBe(false);
  });

  it('serializes the published NEP-413 example in Borsh field order and tag', () => {
    // NEP-413 example: hi, nonce [0..31], myapp.com, myapp.com/callback.
    expect(
      serializeNep413(
        'hi',
        Uint8Array.from({ length: 32 }, (_, i) => i),
        'myapp.com',
        'myapp.com/callback',
      ).toString('hex'),
    ).toBe(
      '9d010080020000006869000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f090000006d796170702e636f6d01120000006d796170702e636f6d2f63616c6c6261636b',
    );
  });

  it('requires NEAR signature AND account FullAccess ownership; binds recipient/callback/nonce', async () => {
    const c = challenge('near:mainnet', 'player.near');
    const payload = serializeNep413(c.message, Buffer.from(c.nonce, 'hex'), c.domain, c.uri);
    const proof = {
      signature: sign(null, createHash('sha256').update(payload).digest(), ed.privateKey).toString(
        'base64',
      ),
      publicKey: `ed25519:${edAddress}`,
    };
    const fullAccess = vi.fn(async () => true);
    expect(await verifyWalletLinkProof(c, proof, fullAccess)).toBe(true);
    expect(fullAccess).toHaveBeenCalledWith('player.near', proof.publicKey);
    expect(await verifyWalletLinkProof(c, proof, async () => false)).toBe(false);
    expect(
      await verifyWalletLinkProof({ ...c, uri: 'https://attacker.test/' }, proof, fullAccess),
    ).toBe(false);
    expect(await verifyWalletLinkProof({ ...c, domain: 'attacker.test' }, proof, fullAccess)).toBe(
      false,
    );
    expect(await verifyWalletLinkProof({ ...c, nonce: 'cd'.repeat(32) }, proof, fullAccess)).toBe(
      false,
    );
    expect(
      await verifyWalletLinkProof(c, { ...proof, publicKey: `secp256k1:${edAddress}` }, fullAccess),
    ).toBe(false);
  });

  it('normalizes EVM case; rejects malformed addresses, off-curve Solana keys and invalid NEAR IDs', () => {
    expect(normalizeWalletLinkAddress('eip155:4663', evm.address)).toBe(evm.address.toLowerCase());
    expect(normalizeWalletLinkAddress('solana:mainnet', edAddress)).toBe(edAddress);
    for (const name of ['Alice.near', 'a', 'foo..near', '-foo.near', 'foo/near']) {
      expect(() => normalizeWalletLinkAddress('near:mainnet', name)).toThrow();
    }
    expect(() => normalizeWalletLinkAddress('eip155:4663', '0xabc')).toThrow();
    const pda = PublicKey.findProgramAddressSync(
      [Buffer.from('wallet-link')],
      new PublicKey(edAddress),
    )[0];
    expect(() => normalizeWalletLinkAddress('solana:mainnet', pda.toBase58())).toThrow();
  });
});

describe('NEAR read-only ownership lookup', () => {
  function rpc(
    options: { chain?: string; permission?: unknown; error?: boolean; stale?: boolean } = {},
  ): typeof fetch {
    return vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      if (request.method === 'query') {
        expect(request.params).toEqual({
          request_type: 'view_access_key',
          finality: 'final',
          account_id: 'player.near',
          public_key: `ed25519:${edAddress}`,
        });
      }
      const result =
        request.method === 'status'
          ? {
              chain_id: options.chain ?? 'mainnet',
              sync_info: {
                syncing: false,
                latest_block_time: new Date(
                  Date.now() - (options.stale ? 180_000 : 0),
                ).toISOString(),
              },
            }
          : {
              permission: options.permission ?? 'FullAccess',
              nonce: 1,
              block_height: 12,
              block_hash: edAddress,
            };
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'wallet-link',
          ...(options.error ? { error: { code: -32000 } } : { result }),
        }),
      );
    }) as typeof fetch;
  }
  it('accepts final mainnet FullAccess only and fails closed on wrong network, restricted keys, stale or failed RPC', async () => {
    expect(
      await createNearFullAccessVerifier('https://rpc.mainnet.near.org', rpc())(
        'player.near',
        `ed25519:${edAddress}`,
      ),
    ).toBe(true);
    for (const options of [
      { chain: 'testnet' },
      { permission: { FunctionCall: {} } },
      { stale: true },
      { error: true },
    ]) {
      expect(
        await createNearFullAccessVerifier('https://rpc.mainnet.near.org', rpc(options))(
          'player.near',
          `ed25519:${edAddress}`,
        ),
      ).toBe(false);
    }
    expect(
      await createNearFullAccessVerifier(
        'https://rpc.mainnet.near.org',
        vi.fn(async () => {
          throw new Error('offline');
        }),
      )('player.near', `ed25519:${edAddress}`),
    ).toBe(false);
    const unused = vi.fn();
    expect(
      await createNearFullAccessVerifier('', unused)('player.near', `ed25519:${edAddress}`),
    ).toBe(false);
    expect(unused).not.toHaveBeenCalled();
  });
});
