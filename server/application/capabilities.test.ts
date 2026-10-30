import { describe, expect, it } from 'vitest';
import { assertCapabilityOn, isCapabilityOn } from './capabilities.js';
import { parseCapabilitiesOn } from '../shared/domain/capabilities.js';
import { CapabilityOffError } from '../shared/domain/errors.js';
import { requireCapability } from '../api/middleware/capability.js';
import type { FastifyRequest } from 'fastify';

const ctxWith = (raw: string | undefined) => ({
  config: { capabilities: parseCapabilitiesOn(raw) },
});

describe('isCapabilityOn / assertCapabilityOn', () => {
  it('is off unless listed', () => {
    expect(isCapabilityOn(ctxWith(undefined), 'worldEvents')).toBe(false);
    expect(isCapabilityOn(ctxWith('homeMove'), 'worldEvents')).toBe(false);
    expect(isCapabilityOn(ctxWith('homeMove,worldEvents'), 'worldEvents')).toBe(true);
  });

  it('throws 503 CAPABILITY_OFF naming the capability while off', () => {
    let caught: unknown;
    try {
      assertCapabilityOn(ctxWith(''), 'paidCalls');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CapabilityOffError);
    const err = caught as CapabilityOffError;
    expect(err.code).toBe('CAPABILITY_OFF');
    expect(err.httpStatus).toBe(503);
    expect(err.details).toEqual({ capability: 'paidCalls' });
    expect(() => assertCapabilityOn(ctxWith('paidCalls'), 'paidCalls')).not.toThrow();
  });
});

describe('requireCapability preHandler', () => {
  const req = (raw: string) => ({ ctx: ctxWith(raw) }) as unknown as FastifyRequest;
  const call = (name: 'factory', raw: string) =>
    (requireCapability(name) as (r: FastifyRequest) => Promise<void>)(req(raw));

  it('rejects while off and passes while on', async () => {
    await expect(call('factory', '')).rejects.toBeInstanceOf(CapabilityOffError);
    await expect(call('factory', 'factory')).resolves.toBeUndefined();
  });
});
