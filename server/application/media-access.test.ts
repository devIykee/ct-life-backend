import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContext } from './context.js';
import type { AppContext } from './context.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { mediaIdentity } from '../shared/livekit/identity.js';
import {
  mintMediaGrant,
  revokeCredentialMedia,
  reconcileMediaParticipant,
  sweepMediaGrants,
  isGameMediaRoom,
  isPlayerMediaDeparture,
} from './media-access.js';
import { applyLiveKitEvent } from './livekit-webhook.js';
import { runInTransaction } from '../shared/db/uow.js';
import type { CredentialClaims } from './login-credentials.js';

const base = buildContext();
const created: string[] = [];
let ctx: AppContext;
let player: string, first: string, retained: string, room: string;
let inventory: Map<string, Array<{ identity: string; sid: string }>>;
const actor = (identity: string): CredentialClaims => ({
  sub: player,
  lid: identity,
  liv: 0,
  am: 'wallet',
  wal: null,
});
const scope = (identity: string) =>
  mediaIdentity({ userId: player, identityId: identity, version: 0 });

beforeEach(async () => {
  if (created.length)
    await base.db.withConnection((c) =>
      c.query('DELETE FROM media_access_grants WHERE user_id=ANY($1::uuid[])', [created]),
    );
  player = uuidv7();
  first = uuidv7();
  retained = uuidv7();
  room = `video:${uuidv7()}`;
  created.push(player);
  await base.db.withConnection(async (c) => {
    await c.query('INSERT INTO users(id,wallet) VALUES($1,NULL)', [player]);
    await c.query(
      "INSERT INTO login_identities(id,user_id,network,address) VALUES($1::uuid,$3,'near:mainnet',$1::text),($2::uuid,$3,'near:mainnet',$2::text)",
      [first, retained, player],
    );
    await c.query(
      "INSERT INTO voice_rooms(room_id,host_user_id,kind,title) VALUES($1,$2,'video','media acceptance fixture')",
      [room, player],
    );
    await c.query(
      "INSERT INTO voice_speakers(speaker_id,room_id,user_id,role) VALUES($1,$2,$3,'host')",
      [uuidv7(), room, player],
    );
  });
  inventory = new Map([[room, []]]);
  ctx = {
    ...base,
    livekit: {
      ...base.livekit,
      mintRtcToken: vi.fn(async (args) => ({
        token: 'public-fixture',
        identity: args.identity,
        roomName: room,
        url: 'ws://localhost',
        canPublish: true,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      })),
      participants: vi.fn(async (_ctx, name) => inventory.get(name) ?? []),
      rooms: vi.fn(async () => [...inventory.keys()]),
      removeParticipant: vi.fn(async (_ctx, args) => {
        const name = `${args.kind}:${args.id}`;
        inventory.set(
          name,
          (inventory.get(name) ?? []).filter((p) => p.identity !== args.identity),
        );
      }),
    },
  };
});

afterAll(async () => {
  await base.db.withConnection(async (c) => {
    await c.query('DELETE FROM media_access_grants WHERE user_id=ANY($1::uuid[])', [created]);
    await c.query('DELETE FROM voice_speakers WHERE user_id=ANY($1::uuid[])', [created]);
    await c.query('DELETE FROM voice_rooms WHERE host_user_id=ANY($1::uuid[])', [created]);
    await c.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [created]);
  });
  await base.db.close();
  await base.redis.close();
});

const mint = (identity = first) =>
  mintMediaGrant(ctx, actor(identity), { kind: 'video', id: room.slice(6) });
async function revoke(identity = first) {
  await runInTransaction(
    async (c) => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [player]);
      await c.query(
        'UPDATE login_identities SET revoked_at=clock_timestamp(),session_version=session_version+1 WHERE id=$1',
        [identity],
      );
    },
    { isolation: 'read committed' },
    base.db,
  );
}

describe('credential-scoped media grants', () => {
  it('registers qualified grants durably before returning and refuses revoked generations', async () => {
    const out = await mint();
    expect(out.identity).toBe(scope(first));
    const rows = await base.db.withConnection((c) =>
      c.query('SELECT * FROM media_access_grants WHERE media_identity=$1', [out.identity]),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].login_identity_id).toBe(first);
    await revoke();
    await expect(mint()).rejects.toMatchObject({ code: 'AUTH_IDENTITY_REVOKED' });
    expect(ctx.livekit.mintRtcToken).toHaveBeenCalledTimes(1);
  });

  it('serialises concurrent revocation behind an in-flight issuance and records its cutoff obligation', async () => {
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = ctx.livekit.mintRtcToken;
    vi.spyOn(ctx.livekit, 'mintRtcToken').mockImplementation(async (args) => {
      started();
      await gate;
      return original(args);
    });
    const issuing = mint();
    await entered;
    let removed = false;
    const removing = revoke().then(() => {
      removed = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(removed).toBe(false);
    release();
    await issuing;
    await removing;
    await revokeCredentialMedia(ctx, { userId: player, identityId: first, minVersion: 1 });
    expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ identity: scope(first), exact: true }),
    );
  });

  it('cuts off a never-connected token without touching the retained credential', async () => {
    await mint();
    await mint(retained);
    await revoke();
    await revokeCredentialMedia(ctx, { userId: player, identityId: first, minVersion: 1 });
    expect(ctx.livekit.removeParticipant).toHaveBeenCalledTimes(1);
    expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ identity: scope(first) }),
    );
    await expect(mint(retained)).resolves.toMatchObject({ identity: scope(retained) });
  });

  it('retains durable obligations through provider failure and retries on a later sweep', async () => {
    await mint();
    await revoke();
    vi.mocked(ctx.livekit.removeParticipant).mockRejectedValueOnce(
      new Error('provider unavailable'),
    );
    await expect(
      revokeCredentialMedia(ctx, { userId: player, identityId: first, minVersion: 1 }),
    ).rejects.toThrow();
    const result = await sweepMediaGrants(ctx);
    expect(result.failures).toBe(0);
    expect(
      vi
        .mocked(ctx.livekit.removeParticipant)
        .mock.calls.filter(([, args]) => args.identity === scope(first)),
    ).toHaveLength(2);
    const count = await base.db.withConnection((c) =>
      c.query('SELECT 1 FROM media_access_grants WHERE media_identity=$1', [scope(first)]),
    );
    expect(count.rowCount).toBe(1);
  });

  it('extends the refreshed-token tail for an observed revoked participant before removing it', async () => {
    await mint();
    await revoke();
    await base.db.withConnection((c) =>
      c.query(
        "UPDATE media_access_grants SET retain_until=clock_timestamp()-interval '1 minute' WHERE media_identity=$1",
        [scope(first)],
      ),
    );
    inventory.set(room, [
      { identity: scope(first), sid: 'old' },
      { identity: scope(retained), sid: 'retained' },
    ]);
    await mint(retained);
    await sweepMediaGrants(ctx);
    expect(inventory.get(room)?.map((p) => p.identity)).toEqual([scope(retained)]);
    const row = await base.db.withConnection((c) =>
      c.query<{ retain_until: Date }>(
        'SELECT retain_until FROM media_access_grants WHERE media_identity=$1',
        [scope(first)],
      ),
    );
    expect(row.rows[0]!.retain_until.getTime()).toBeGreaterThan(Date.now() + 600000);
  });

  it('retires only the exact legacy identity, leaving its qualified sibling connected', async () => {
    await mint(retained);
    inventory.set(room, [
      { identity: player, sid: 'legacy' },
      { identity: scope(retained), sid: 'retained' },
    ]);
    expect(await reconcileMediaParticipant(ctx, room, player)).toBe(false);
    expect(inventory.get(room)?.map((p) => p.identity)).toEqual([scope(retained)]);
  });

  it('reconciles account deletion without a cascading loss of grant obligations', async () => {
    await mint();
    await base.db.withConnection((c) =>
      c.query('UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1', [player]),
    );
    expect(await reconcileMediaParticipant(ctx, room, scope(first))).toBe(false);
    expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ identity: scope(first) }),
    );
  });

  it('does not close player membership for a retained sibling or a late leave after reconnect', async () => {
    await mint();
    await mint(retained);
    inventory.set(room, [{ identity: scope(retained), sid: 'retained' }]);
    await applyLiveKitEvent(ctx, uuidv7(), {
      event: 'participant_left',
      room: { name: room },
      participant: { identity: scope(first), sid: 'old' },
    });
    const read = () =>
      base.db.withConnection((c) =>
        c.query<{ left_at: Date | null }>(
          'SELECT left_at FROM voice_speakers WHERE room_id=$1 AND user_id=$2',
          [room, player],
        ),
      );
    expect((await read()).rows[0]!.left_at).toBeNull();
    inventory.set(room, [{ identity: scope(first), sid: 'new' }]);
    await applyLiveKitEvent(ctx, uuidv7(), {
      event: 'participant_left',
      room: { name: room },
      participant: { identity: scope(first), sid: 'old' },
    });
    expect((await read()).rows[0]!.left_at).toBeNull();
    inventory.set(room, []);
    await applyLiveKitEvent(ctx, uuidv7(), {
      event: 'participant_left',
      room: { name: room },
      participant: { identity: scope(first), sid: 'new' },
    });
    expect((await read()).rows[0]!.left_at).not.toBeNull();
  });

  it('removes unchecked media on an authority outage but never treats it as durable revocation', async () => {
    await mint();
    const outage = {
      ...ctx,
      db: {
        ...ctx.db,
        withConnection: vi.fn().mockRejectedValue(new Error('database unavailable')),
      },
    } as AppContext;
    await expect(reconcileMediaParticipant(outage, room, scope(first))).rejects.toThrow(
      'database unavailable',
    );
    expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
      outage,
      expect.objectContaining({ identity: scope(first), exact: true }),
    );
    expect(await reconcileMediaParticipant(ctx, room, scope(first))).toBe(true);
  });

  it('ignores unrelated provider rooms', async () => {
    expect(isGameMediaRoom('other-service:meeting')).toBe(false);
    expect(
      await reconcileMediaParticipant(ctx, 'other-service:meeting', 'other-service-user'),
    ).toBe(true);
    expect(ctx.livekit.removeParticipant).not.toHaveBeenCalled();
  });

  it('does not interpret an outsider or malformed identity as a paid-call departure', async () => {
    await mint(retained);
    expect(await isPlayerMediaDeparture(ctx, room, uuidv7())).toBe(false);
    expect(await isPlayerMediaDeparture(ctx, room, 'ct1:invalid')).toBe(false);
    expect(await isPlayerMediaDeparture(ctx, 'other-service:meeting', player)).toBe(false);
    inventory.set(room, [{ identity: scope(retained), sid: 'remaining' }]);
    expect(await isPlayerMediaDeparture(ctx, room, scope(first))).toBe(false);
  });

  it('retries durable offline cutoffs when provider room enumeration fails', async () => {
    await mint();
    await revoke();
    vi.mocked(ctx.livekit.rooms).mockRejectedValueOnce(new Error('inventory unavailable'));
    const result = await sweepMediaGrants(ctx);
    expect(result.failures).toBe(1);
    expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ identity: scope(first) }),
    );
  });

  it('retains an expired obligation when participant absence could not be verified', async () => {
    await mint();
    await revoke();
    await base.db.withConnection((c) =>
      c.query(
        "UPDATE media_access_grants SET retain_until=clock_timestamp()-interval '1 minute' WHERE media_identity=$1",
        [scope(first)],
      ),
    );
    vi.mocked(ctx.livekit.participants).mockRejectedValue(new Error('inventory unavailable'));
    expect((await sweepMediaGrants(ctx)).failures).toBeGreaterThan(0);
    const row = await base.db.withConnection((c) =>
      c.query('SELECT 1 FROM media_access_grants WHERE media_identity=$1', [scope(first)]),
    );
    expect(row.rowCount).toBe(1);
  });

  it.each(['ended', 'departed'])(
    'rejects a still-valid credential after its room authority is %s',
    async (reason) => {
      await mint();
      await base.db.withConnection((c) =>
        reason === 'ended'
          ? c.query(
              "UPDATE voice_rooms SET status='ended',ended_at=clock_timestamp() WHERE room_id=$1",
              [room],
            )
          : c.query(
              'UPDATE voice_speakers SET left_at=clock_timestamp() WHERE room_id=$1 AND user_id=$2',
              [room, player],
            ),
      );
      expect(await reconcileMediaParticipant(ctx, room, scope(first))).toBe(false);
      expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ identity: scope(first) }),
      );
    },
  );

  it('does not retain a departed player merely because an unregistered or revoked sibling is listed', async () => {
    await mint();
    await mint(retained);
    await revoke(retained);
    inventory.set(room, [
      { identity: scope(retained), sid: 'revoked' },
      { identity: player, sid: 'legacy' },
    ]);
    expect(await isPlayerMediaDeparture(ctx, room, scope(first))).toBe(true);
  });

  it('new credential generations remain independent after re-enrolment', async () => {
    await mint();
    await revoke();
    await base.db.withConnection((c) =>
      c.query('UPDATE login_identities SET revoked_at=NULL WHERE id=$1', [first]),
    );
    const newer = await mintMediaGrant(
      ctx,
      { ...actor(first), liv: 1 },
      { kind: 'video', id: room.slice(6) },
    );
    inventory.set(room, [
      { identity: scope(first), sid: 'old' },
      { identity: newer.identity, sid: 'new' },
    ]);
    await sweepMediaGrants(ctx);
    expect(inventory.get(room)?.map((p) => p.identity)).toEqual([newer.identity]);
  });

  it('cuts off known revoked tokens even when participant inventory is unavailable', async () => {
    await mint();
    await revoke();
    vi.mocked(ctx.livekit.participants).mockRejectedValue(new Error('inventory unavailable'));
    await sweepMediaGrants(ctx);
    expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ identity: scope(first) }),
    );
  });

  it('rotates a bounded participant slice within a crowded room', async () => {
    inventory.set(
      room,
      Array.from({ length: 9 }, (_, n) => ({ identity: `legacy-invalid-${n}`, sid: `sid-${n}` })),
    );
    const firstPass = await sweepMediaGrants(ctx);
    expect(ctx.livekit.removeParticipant).toHaveBeenCalledTimes(4);
    // A stable provider inventory permits cursor progress without processing every participant in one pass.
    inventory.set(
      room,
      Array.from({ length: 9 }, (_, n) => ({ identity: `legacy-invalid-${n}`, sid: `sid-${n}` })),
    );
    vi.mocked(ctx.livekit.removeParticipant).mockClear();
    await sweepMediaGrants(ctx, firstPass.nextRoomCursor, firstPass.participantOffsets);
    expect(
      vi
        .mocked(ctx.livekit.removeParticipant)
        .mock.calls.map(([, args]) => args.identity)
        .sort(),
    ).toEqual(['legacy-invalid-4', 'legacy-invalid-5', 'legacy-invalid-6', 'legacy-invalid-7']);
  });

  it('does not let retained successful cutoffs starve ended-room grants with active credentials', async () => {
    await mint();
    await mint(retained);
    await revoke();
    await base.db.withConnection(async (c) => {
      await c.query(
        `UPDATE media_access_grants SET cutoff_succeeded_at=clock_timestamp(),next_check_at=clock_timestamp()-interval '1 hour'
         WHERE room_name=$1 AND media_identity=$2`,
        [room, scope(first)],
      );
      await c.query(
        `INSERT INTO media_access_grants(room_name,media_identity,user_id,login_identity_id,credential_version,issued_expires_at,retain_until,next_check_at,cutoff_succeeded_at)
         SELECT x.room,g.media_identity,g.user_id,g.login_identity_id,g.credential_version,g.issued_expires_at,g.retain_until,g.next_check_at,g.cutoff_succeeded_at
         FROM media_access_grants g CROSS JOIN unnest($2::text[]) x(room)
         WHERE g.room_name=$1 AND g.media_identity=$3`,
        [room, Array.from({ length: 127 }, () => `video:${uuidv7()}`), scope(first)],
      );
      await c.query(
        `UPDATE media_access_grants SET next_check_at=clock_timestamp()-interval '2 hours'
         WHERE room_name=$1 AND media_identity=$2`,
        [room, scope(retained)],
      );
      await c.query("UPDATE voice_rooms SET status='ended' WHERE room_id=$1", [room]);
    });
    const result = await sweepMediaGrants(ctx);
    expect(result.checked).toBe(128);
    expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ identity: scope(retained) }),
    );
  });

  it('still disconnects unchecked media when its attempt timestamp cannot be written', async () => {
    await mint();
    const query = ctx.db.withConnection;
    const writeFailure = vi
      .spyOn(ctx.db, 'withConnection')
      .mockImplementationOnce(query)
      .mockRejectedValueOnce(new Error('attempt timestamp unavailable'));
    try {
      expect((await sweepMediaGrants(ctx)).failures).toBeGreaterThan(0);
      expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ identity: scope(first), exact: true }),
      );
    } finally {
      writeFailure.mockRestore();
    }
    const remaining = await base.db.withConnection((c) =>
      c.query('SELECT 1 FROM media_access_grants WHERE room_name=$1 AND media_identity=$2', [
        room,
        scope(first),
      ]),
    );
    expect(remaining.rowCount).toBe(1);
  });

  it('advances authority failures so venue outages cannot starve ended-call cutoffs', async () => {
    await mint();
    await base.db.withConnection(async (c) => {
      await c.query(
        `INSERT INTO media_access_grants(room_name,media_identity,user_id,login_identity_id,credential_version,issued_expires_at,retain_until,next_check_at)
         SELECT x.room,g.media_identity,g.user_id,g.login_identity_id,g.credential_version,g.issued_expires_at,g.retain_until,clock_timestamp()-interval '1 hour'
         FROM media_access_grants g CROSS JOIN unnest($2::text[]) x(room)
         WHERE g.room_name=$1 AND g.media_identity=$3`,
        [room, Array.from({ length: 128 }, (_, n) => `venue:outage-${n}`), scope(first)],
      );
      await c.query("UPDATE voice_rooms SET status='ended' WHERE room_id=$1", [room]);
    });
    const authority = vi
      .spyOn(ctx.redis.main, 'hget')
      .mockRejectedValue(new Error('venue authority unavailable'));
    try {
      const firstPass = await sweepMediaGrants(ctx);
      expect(firstPass.checked).toBe(128);
      expect(firstPass.failures).toBeGreaterThan(0);
      expect(ctx.livekit.removeParticipant).not.toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ kind: 'video', id: room.slice(6) }),
      );
      await sweepMediaGrants(ctx);
      expect(ctx.livekit.removeParticipant).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ kind: 'video', id: room.slice(6), identity: scope(first) }),
      );
    } finally {
      authority.mockRestore();
    }
  });

  it('does not let a full batch of failed provider cutoffs starve later revoked grants', async () => {
    await mint();
    await revoke();
    const extra = Array.from({ length: 129 }, () => `video:${uuidv7()}`);
    await base.db.withConnection((c) =>
      c.query(
        `INSERT INTO media_access_grants(room_name,media_identity,user_id,login_identity_id,credential_version,issued_expires_at,retain_until,next_check_at)
       SELECT x.room,g.media_identity,g.user_id,g.login_identity_id,g.credential_version,g.issued_expires_at,g.retain_until,
       clock_timestamp()-interval '1 hour'+x.ordinality*interval '1 millisecond'
       FROM media_access_grants g CROSS JOIN unnest($2::text[]) WITH ORDINALITY x(room,ordinality)
       WHERE g.room_name=$1 AND g.media_identity=$3`,
        [room, extra, scope(first)],
      ),
    );
    vi.mocked(ctx.livekit.removeParticipant).mockRejectedValue(
      new Error('persistent provider failure'),
    );
    await sweepMediaGrants(ctx);
    expect(
      vi
        .mocked(ctx.livekit.removeParticipant)
        .mock.calls.some(([, args]) => `video:${args.id}` === extra[128]),
    ).toBe(false);
    await sweepMediaGrants(ctx);
    expect(
      vi
        .mocked(ctx.livekit.removeParticipant)
        .mock.calls.some(([, args]) => `video:${args.id}` === extra[128]),
    ).toBe(true);
  });
});
