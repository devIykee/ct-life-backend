/**
 * Real Markets value helpers: USDC amounts, micro-USD prices, country lists and the
 * fail-closed geo decision.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOCKED_COUNTRIES,
  DEFAULT_BLOCKED_REGIONS,
  baseToUsdc,
  decideGeo,
  microUsdToDecimal,
  parseCountryList,
  parseRegionList,
  usdcToBase,
} from './real-markets.js';

describe('usdc amounts', () => {
  it('parses decimal strings to base units and back', () => {
    expect(usdcToBase('20')).toBe(20_000_000n);
    expect(usdcToBase('20.5')).toBe(20_500_000n);
    expect(usdcToBase('0.000001')).toBe(1n);
    expect(baseToUsdc(20_000_000n)).toBe('20.00');
    expect(baseToUsdc(20_500_000n)).toBe('20.50');
    expect(baseToUsdc(1n)).toBe('0.000001');
  });

  it('refuses zero, negatives, too many decimals and junk', () => {
    for (const bad of ['0', '0.0', '-1', '1.0000001', '1e3', 'abc', '', '01', ' 1']) {
      expect(usdcToBase(bad), bad).toBeNull();
    }
  });

  it('reads micro USD as decimal USD', () => {
    expect(microUsdToDecimal(850_000)).toBe('0.85');
    expect(microUsdToDecimal('16824124000000')).toBe('16824124.00');
    expect(microUsdToDecimal(null)).toBeNull();
    expect(microUsdToDecimal('1.5')).toBeNull();
  });
});

describe('country lists', () => {
  it('upper-cases codes and reports invalid entries', () => {
    expect(parseCountryList(' gb, fr ,,')).toEqual({ codes: ['GB', 'FR'], invalid: [] });
    expect(parseCountryList('GBR,F').invalid).toEqual(['GBR', 'F']);
    expect(parseRegionList('ua-43, UA-9').codes).toEqual(['UA-43', 'UA-9']);
    expect(parseRegionList('crimea').invalid).toEqual(['crimea']);
  });

  it('seeds the providers restricted countries', () => {
    // Jupiter Prediction API (US, KR) and Jupiter Terms Prohibited Localities.
    for (const c of ['US', 'KR', 'SG', 'CU', 'IR', 'KP', 'SY']) {
      expect(DEFAULT_BLOCKED_COUNTRIES).toContain(c);
    }
    // Nigeria, the UK and the EU are not on any provider list (research 2026-10-30).
    for (const c of ['NG', 'GB', 'DE']) expect(DEFAULT_BLOCKED_COUNTRIES).not.toContain(c);
  });
});

describe('decideGeo', () => {
  const blockedCountries = new Set(DEFAULT_BLOCKED_COUNTRIES);
  const blockedRegions = new Set(DEFAULT_BLOCKED_REGIONS);
  const base = { region: null, blockedCountries, blockedRegions, allowUnknown: false };

  it('allows a listed-safe country', () => {
    expect(decideGeo({ ...base, country: 'ng' })).toEqual({ allowed: true, country: 'NG' });
  });

  it('blocks a deny-listed country', () => {
    expect(decideGeo({ ...base, country: 'US' })).toEqual({
      allowed: false,
      country: 'US',
      reason: 'blocked_country',
    });
  });

  it('fails closed with no country, XX (unknown) or T1 (Tor)', () => {
    for (const c of [null, '', 'XX', 'T1', 'USA']) {
      const d = decideGeo({ ...base, country: c });
      expect(d.allowed, String(c)).toBe(false);
      if (!d.allowed) expect(d.reason).toBe('unknown_country');
    }
    expect(decideGeo({ ...base, country: null, allowUnknown: true }).allowed).toBe(true);
  });

  it('blocks sanctioned regions with or without the country prefix', () => {
    expect(decideGeo({ ...base, country: 'UA', region: '43' })).toMatchObject({
      allowed: false,
      reason: 'blocked_region',
    });
    expect(decideGeo({ ...base, country: 'UA', region: 'UA-14' })).toMatchObject({
      allowed: false,
      reason: 'blocked_region',
    });
    expect(decideGeo({ ...base, country: 'UA', region: '30' }).allowed).toBe(true);
  });
});
