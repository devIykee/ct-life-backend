/**
 * WEB_ORIGINS parsing, the realtime Origin verdict and the SIWS bindings (pure).
 */
import { describe, expect, it } from 'vitest';
import {
  checkRealtimeOrigin,
  matchWebOrigin,
  parseWebOrigins,
  siwsAllowList,
  siwsBindingForOrigin,
  WebOriginsEnvError,
} from './web-origins.js';

describe('parseWebOrigins', () => {
  it('accepts exact https origins, normalises and de-duplicates', () => {
    expect(
      parseWebOrigins(
        ' https://play.ctlife.fun , https://Staging.Play.CTLife.fun/,https://play.ctlife.fun,',
      ),
    ).toEqual(['https://play.ctlife.fun', 'https://staging.play.ctlife.fun']);
    expect(parseWebOrigins(undefined)).toEqual([]);
    expect(parseWebOrigins('')).toEqual([]);
  });

  it('accepts http only for localhost, and keeps a non-default port', () => {
    expect(parseWebOrigins('http://localhost:8080,http://127.0.0.1:5173')).toEqual([
      'http://localhost:8080',
      'http://127.0.0.1:5173',
    ]);
    expect(parseWebOrigins('https://play.ctlife.fun:8443')).toEqual([
      'https://play.ctlife.fun:8443',
    ]);
  });

  it('refuses wildcards, null, paths, credentials, plain http and other schemes', () => {
    for (const bad of [
      '*',
      'null',
      'https://*.ctlife.fun',
      'play.ctlife.fun',
      'https://play.ctlife.fun/game',
      'https://play.ctlife.fun?x=1',
      'https://user:pw@play.ctlife.fun',
      'http://play.ctlife.fun',
      'ws://play.ctlife.fun',
      'file:///tmp',
    ]) {
      expect(() => parseWebOrigins(bad), bad).toThrow(WebOriginsEnvError);
    }
  });
});

describe('origin checks', () => {
  const allowed = parseWebOrigins('https://play.ctlife.fun');

  it('matches exactly (case-insensitive), nothing looser', () => {
    expect(matchWebOrigin('https://play.ctlife.fun', allowed)).toBe('https://play.ctlife.fun');
    expect(matchWebOrigin('HTTPS://PLAY.CTLIFE.FUN', allowed)).toBe('https://play.ctlife.fun');
    for (const o of [
      'https://play.ctlife.fun.evil.example',
      'https://evil-play.ctlife.fun',
      'http://play.ctlife.fun',
      'https://play.ctlife.fun:444',
      'null',
      '',
      undefined,
    ]) {
      expect(matchWebOrigin(o, allowed), String(o)).toBeNull();
    }
  });

  it('realtime: no Origin is native, listed is allowed, anything else refused', () => {
    expect(checkRealtimeOrigin(undefined, allowed)).toBe('native');
    expect(checkRealtimeOrigin('', allowed)).toBe('native');
    expect(checkRealtimeOrigin('https://play.ctlife.fun', allowed)).toBe('allowed');
    expect(checkRealtimeOrigin('https://evil.example', allowed)).toBe('refused');
    expect(checkRealtimeOrigin('null', allowed)).toBe('refused');
    expect(checkRealtimeOrigin('https://play.ctlife.fun', [])).toBe('refused');
  });
});

describe('SIWS bindings', () => {
  it('domain is the host (with a non-default port), uri the origin with a slash', () => {
    expect(siwsBindingForOrigin('https://play.ctlife.fun')).toEqual({
      domain: 'play.ctlife.fun',
      uri: 'https://play.ctlife.fun/',
    });
    expect(siwsBindingForOrigin('http://localhost:8080')).toEqual({
      domain: 'localhost:8080',
      uri: 'http://localhost:8080/',
    });
  });

  it('allow-list is the native pair then one per web origin', () => {
    const native = { domain: 'ctlife.fun', uri: 'https://ctlife.fun/' };
    expect(
      siwsAllowList(native, ['https://play.ctlife.fun', 'https://ctlife.fun']).map((b) => b.domain),
    ).toEqual(['ctlife.fun', 'play.ctlife.fun']);
  });
});
