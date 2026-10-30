import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_APPS,
  CAPABILITY_FEATURES,
  buildCapabilitiesPayload,
  parseCapabilitiesOn,
} from './capabilities.js';

describe('parseCapabilitiesOn', () => {
  it('is all off when unset, empty or blank (fail closed, no code defaults)', () => {
    for (const raw of [undefined, '', ' ', ',,', ' , ']) {
      const p = parseCapabilitiesOn(raw);
      expect(p.on.size, String(raw)).toBe(0);
      expect(p.ignored).toEqual([]);
    }
  });

  it('turns on known names, trimmed, and ignores unknown ones', () => {
    const p = parseCapabilitiesOn(
      ' worldEvents ,districtStandings,beef, rugRoom,worldEvents,nope,nope',
    );
    expect([...p.on].sort()).toEqual(['beef', 'districtStandings', 'worldEvents']);
    expect(p.ignored).toEqual(['rugRoom', 'nope']);
  });

  it('matches names exactly, so a wrong case stays off', () => {
    const p = parseCapabilitiesOn('WorldEvents,BEEF');
    expect(p.on.size).toBe(0);
    expect(p.ignored).toEqual(['WorldEvents', 'BEEF']);
  });
});

describe('buildCapabilitiesPayload', () => {
  it('sends every known key as false when nothing is on', () => {
    const body = buildCapabilitiesPayload(new Set());
    expect(body.capabilities.version).toBe(2);
    expect(Object.keys(body.capabilities.apps).sort()).toEqual([...CAPABILITY_APPS].sort());
    expect(Object.keys(body.capabilities.features).sort()).toEqual([...CAPABILITY_FEATURES].sort());
    expect(Object.values(body.capabilities.apps).every((v) => v === false)).toBe(true);
    expect(Object.values(body.capabilities.features).every((v) => v === false)).toBe(true);
    expect(body.competitionCapabilities).toEqual({
      version: 1,
      beefChallenges: false,
      targetedCabalInvites: false,
    });
  });

  it('matches the plan shape exactly', () => {
    const body = buildCapabilitiesPayload(new Set());
    expect(body).toEqual({
      capabilities: {
        version: 2,
        apps: { beef: false, builder: false, vc: false, predict: false },
        features: {
          beefVoting: false,
          districtStandings: false,
          seasonResults: false,
          sybilBail: false,
          sybilBarn: false,
          cabalRevoke: false,
          xUnlink: false,
          worldEvents: false,
          homeMove: false,
          visitorPolicy: false,
          nftGallery: false,
          paidCalls: false,
          creatorMode: false,
          seasonPassPurchase: false,
          factory: false,
          projectHq: false,
          devnetDrip: false,
        },
      },
      competitionCapabilities: { version: 1, beefChallenges: false, targetedCabalInvites: false },
    });
  });

  it('derives competitionCapabilities: beefChallenges from apps.beef, invites from cabalInvites', () => {
    const body = buildCapabilitiesPayload(parseCapabilitiesOn('beef,cabalInvites,paidCalls').on);
    expect(body.capabilities.apps.beef).toBe(true);
    expect(body.capabilities.features.paidCalls).toBe(true);
    expect(body.capabilities.features.cabalRevoke).toBe(false);
    expect(body.competitionCapabilities).toEqual({
      version: 1,
      beefChallenges: true,
      targetedCabalInvites: true,
    });
    // cabalInvites only drives the derived key; it is not a feature key.
    expect('cabalInvites' in body.capabilities.features).toBe(false);
  });
});
