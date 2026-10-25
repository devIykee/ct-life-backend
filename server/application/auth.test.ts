/**
 * Auth service tests - B0 SPKI verification
 */
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { createPublicKey, verify, sign, generateKeyPairSync } from 'node:crypto';

describe('B0: SPKI ed25519 signature verification', () => {
  it('should verify ed25519 signature using SPKI-wrapped public key', () => {
    // Generate test keypair using node:crypto
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');

    // Get the raw 32-byte public key
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const rawPublicKey = publicKeyDer.slice(-32); // Last 32 bytes are the actual key

    // Create Solana PublicKey from raw bytes
    const solanaPublicKey = new PublicKey(rawPublicKey);
    const wallet = solanaPublicKey.toBase58();

    const message = 'Test message for SIWS';
    const messageBuffer = Buffer.from(message, 'utf8');

    // Sign the message
    const signature = sign(null, messageBuffer, privateKey);
    const signatureB64 = signature.toString('base64');

    // Test SPKI wrapping (the B0 fix)
    const pubkey = new PublicKey(wallet);
    const pub = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(pubkey.toBytes()),
      ]),
      format: 'der',
      type: 'spki',
    });

    const sig = Buffer.from(signatureB64, 'base64');
    const verified = verify(null, messageBuffer, pub, sig);

    expect(verified).toBe(true);
  });

  it('should reject signatures with wrong key', () => {
    const { publicKey: publicKey1 } = generateKeyPairSync('ed25519');
    const { privateKey: privateKey2 } = generateKeyPairSync('ed25519');

    const publicKeyDer = publicKey1.export({ type: 'spki', format: 'der' });
    const rawPublicKey = publicKeyDer.slice(-32);
    const solanaPublicKey = new PublicKey(rawPublicKey);
    const wallet = solanaPublicKey.toBase58();

    const message = 'Test message';
    const messageBuffer = Buffer.from(message, 'utf8');

    // Sign with wrong key
    const signature = sign(null, messageBuffer, privateKey2);
    const signatureB64 = signature.toString('base64');

    const pubkey = new PublicKey(wallet);
    const pub = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(pubkey.toBytes()),
      ]),
      format: 'der',
      type: 'spki',
    });

    const sig = Buffer.from(signatureB64, 'base64');
    const verified = verify(null, messageBuffer, pub, sig);

    expect(verified).toBe(false);
  });

  it('should handle SPKI prefix correctly (12 bytes)', () => {
    const prefix = Buffer.from('302a300506032b6570032100', 'hex');
    expect(prefix.length).toBe(12);

    // SPKI DER structure for ed25519:
    // 30 2a - SEQUENCE, length 42 bytes
    // 30 05 - SEQUENCE, length 5 bytes (AlgorithmIdentifier)
    // 06 03 2b 65 70 - OID 1.3.101.112 (ed25519)
    // 03 21 00 - BIT STRING, length 33 bytes (32 byte key + unused bits byte)
  });
});
