/**
 * Client platform resolution, per-platform minimum versions and the kill-list (pure).
 */
import { describe, expect, it } from 'vitest';
import {
  capabilitiesOffFor,
  capabilitiesOnFor,
  isVersionBelow,
  minClientVersionFor,
  parseCapabilitiesOffByPlatform,
  parseClientBuild,
  parseMinVersionByPlatform,
  PlatformEnvError,
  resolveClientPlatform,
  updateInstructionFor,
} from './client-platform.js';
import type { CapabilityName } from './capabilities.js';

describe('resolveClientPlatform', () => {
  it('uses a known X-Client-Platform and scopes the request', () => {
    for (const p of ['android', 'web', 'desktop', 'ios'] as const) {
      expect(resolveClientPlatform({ platform: p })).toEqual({
        platform: p,
        declared: p,
        build: null,
        scoped: true,
      });
    }
    expect(resolveClientPlatform({ platform: ' Web ' }).platform).toBe('web');
  });

  it('treats any request with an Origin as web, whatever it claims', () => {
    const r = resolveClientPlatform({ platform: 'android', origin: 'https://evil.example' });
    expect(r).toMatchObject({ platform: 'web', declared: 'android', scoped: true });
    expect(resolveClientPlatform({ origin: 'https://play.ctlife.fun' }).platform).toBe('web');
  });

  it('no header and no Origin is a legacy native client: android, not scoped', () => {
    expect(resolveClientPlatform({})).toEqual({
      platform: 'android',
      declared: null,
      build: null,
      scoped: false,
    });
    expect(resolveClientPlatform({ platform: '' }).scoped).toBe(false);
  });

  it('an unknown platform value is unknown and scoped', () => {
    expect(resolveClientPlatform({ platform: 'mac' })).toMatchObject({
      platform: 'unknown',
      declared: 'mac',
      scoped: true,
    });
  });

  it('reads X-Client-Build as a plain integer only', () => {
    expect(resolveClientPlatform({ platform: 'web', build: '2716521' }).build).toBe(2716521);
    expect(parseClientBuild('0')).toBe(0);
    for (const bad of ['', '-1', '1.5', 'abc', '1e3', '1234567890123456']) {
      expect(parseClientBuild(bad), bad).toBeNull();
    }
    expect(resolveClientPlatform({ platform: ['ios', 'web'], build: ['7'] })).toMatchObject({
      platform: 'ios',
      build: 7,
    });
  });
});

describe('versions', () => {
  it('compares dotted versions numerically', () => {
    expect(isVersionBelow('0.9.9', '1.0.0')).toBe(true);
    expect(isVersionBelow('1.0.0', '1.0.0')).toBe(false);
    expect(isVersionBelow('1.10.0', '1.9.0')).toBe(false);
    expect(isVersionBelow('1.5', '1.5.1')).toBe(true);
    expect(isVersionBelow('2.0.0-rc1', '1.9.9')).toBe(false);
  });

  it('per-platform minimum, never below the 1.0.0 floor', () => {
    const by = parseMinVersionByPlatform('{"android":"1.5.0","web":"1.6.0","ios":"0.5.0"}');
    expect(minClientVersionFor(by, 'android')).toBe('1.5.0');
    expect(minClientVersionFor(by, 'web')).toBe('1.6.0');
    expect(minClientVersionFor(by, 'ios')).toBe('1.0.0');
    expect(minClientVersionFor(by, 'desktop')).toBe('1.0.0');
    expect(minClientVersionFor(by, 'unknown')).toBe('1.0.0');
    expect(minClientVersionFor({}, 'web')).toBe('1.0.0');
  });

  it('web is told to reload, the apps to update from the store', () => {
    expect(updateInstructionFor('web').action).toBe('reload');
    expect(updateInstructionFor('web').message).toMatch(/Reload/);
    for (const p of ['android', 'ios', 'desktop', 'unknown'] as const) {
      expect(updateInstructionFor(p).action).toBe('store');
    }
  });

  it('MIN_CLIENT_VERSION_BY_PLATFORM: empty is none, malformed throws', () => {
    expect(parseMinVersionByPlatform(undefined)).toEqual({});
    expect(parseMinVersionByPlatform('  ')).toEqual({});
    for (const bad of ['nope', '[]', '"1.0.0"', '{"mac":"1.0.0"}', '{"web":"1.6"}', '{"web":2}']) {
      expect(() => parseMinVersionByPlatform(bad), bad).toThrow(PlatformEnvError);
    }
  });
});

describe('CAPABILITIES_OFF_BY_PLATFORM', () => {
  const on = new Set<CapabilityName>(['paidCalls', 'seasonPassPurchase', 'worldEvents', 'factory']);

  it('parses known names, reports unknown ones, throws on bad shape', () => {
    const k = parseCapabilitiesOffByPlatform(
      '{"web":["paidCalls","seasonPassPurchase","notAThing"],"ios":["factory"]}',
    );
    expect([...(k.off.web ?? [])]).toEqual(['paidCalls', 'seasonPassPurchase']);
    expect(k.ignored).toEqual(['web:notAThing']);
    expect(parseCapabilitiesOffByPlatform('')).toEqual({ off: {}, ignored: [] });
    for (const bad of ['x', '{"web":"paidCalls"}', '{"pc":["paidCalls"]}', '{"web":[1]}']) {
      expect(() => parseCapabilitiesOffByPlatform(bad), bad).toThrow(PlatformEnvError);
    }
  });

  it('removes a platform list from CAPABILITIES_ON and leaves other platforms alone', () => {
    const k = parseCapabilitiesOffByPlatform('{"web":["paidCalls"],"ios":["factory"]}');
    expect([...capabilitiesOnFor(on, k, 'web')].sort()).toEqual([
      'factory',
      'seasonPassPurchase',
      'worldEvents',
    ]);
    expect(capabilitiesOnFor(on, k, 'android')).toBe(on);
    expect([...capabilitiesOffFor(k, 'desktop')]).toEqual([]);
  });

  it('an unknown platform loses the union of every list (fail closed)', () => {
    const k = parseCapabilitiesOffByPlatform('{"web":["paidCalls"],"ios":["factory"]}');
    expect([...capabilitiesOffFor(k, 'unknown')].sort()).toEqual(['factory', 'paidCalls']);
    expect([...capabilitiesOnFor(on, k, 'unknown')].sort()).toEqual([
      'seasonPassPurchase',
      'worldEvents',
    ]);
  });
});
