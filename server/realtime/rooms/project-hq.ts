/**
 * Project HQ room (`project_hq`, unlock WP-B B3).
 *
 * A VenueRoom with the `hackathon_house` layout (walkable, spots, move/sit/
 * emote/say all come from VenueRoom unchanged; WP-A keeps sole ownership of
 * venue.ts). One instance per project: defined with `filterBy(['projectId'])`
 * and the fixed roomId `hq_<projectId>`, capped at `hq.maxClients` (12).
 *
 * Join (`joinOrCreate('project_hq', {projectId, token})`, or `joinById(roomId)`
 * once it exists):
 *   - behind the `projectHq` capability (4503 `capability_off` otherwise);
 *   - members always enter; anyone else only while a member is inside
 *     (4403 `members_only`); a rugged project's HQ is closed (4409
 *     `wrong_status`); a bad project id is 4404 `not_found`;
 *   - when the last member leaves, visitors are shown out (4403 members_only).
 *
 * Every 30 s the room publishes the members inside to Redis (the API checks it
 * before issuing a visitor ticket) and logs an HQ shift (`project_work_log`,
 * `hq_shift`) for a non-founder member who has been in for `hq.shiftMinutes`.
 */
import { ServerError, type Client } from 'colyseus';
import { VenueRoom } from './venue.js';
import { authenticateJoin } from '../player.js';
import { loadConfig } from '../../shared/config/config.js';
import { isCapabilityOn } from '../../application/capabilities.js';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Join refusals the Colyseus client can read: `ServerError(code, reason)`
 * reaches `joinOrCreate`/`joinById` as `{code, message}` (Colyseus keeps an
 * error's numeric `code`). Codes mirror the HTTP status (44xx, like the 4403
 * kick home.ts and this room use).
 */
export const HQ_JOIN_ERRORS = {
  members_only: 4403,
  not_found: 4404,
  wrong_status: 4409,
  capability_off: 4503,
} as const;

function refuse(reason: keyof typeof HQ_JOIN_ERRORS): ServerError {
  return new ServerError(HQ_JOIN_ERRORS[reason], reason);
}
const TICK_MS = 30_000;

interface Visitor {
  readonly userId: string;
  readonly member: boolean;
  readonly joinedAt: number;
  shiftLogged: boolean;
}

export class ProjectHqRoom extends VenueRoom {
  private projectId = '';
  private shiftMs = 10 * 60_000;
  private readonly visitors = new Map<string, Visitor>();

  /**
   * Create the HQ for one project.
   * @param options - `projectId` (uuid) scopes the room.
   */
  override async onCreate(options: unknown): Promise<void> {
    if (!isCapabilityOn({ config: loadConfig() }, 'projectHq')) throw refuse('capability_off');
    const projectId = String((options as { projectId?: string } | undefined)?.projectId ?? '');
    if (!UUID.test(projectId)) throw refuse('not_found');
    this.projectId = projectId;
    const { hqRoomId } = await import('../../application/project-hq.js');
    // The roomId may only be replaced during onCreate (Colyseus Room docs).
    this.roomId = hqRoomId(projectId);
    await super.onCreate({ venueId: 'hackathon_house' });
    const { buildContext } = await import('../../application/context.js');
    const { projectsConfig } = await import('../../application/project-events.js');
    const hq = projectsConfig(buildContext()).hq;
    this.maxClients = hq.maxClients;
    this.shiftMs = hq.shiftMinutes * 60_000;
    this.clock.setInterval(() => void this.tick(), TICK_MS);
  }

  /**
   * Admit members always, visitors only while a member is inside.
   * @param client - The joining client.
   * @param options - Join options; only `token` is trusted.
   */
  override async onJoin(client: Client, options: unknown): Promise<void> {
    const userId = await authenticateJoin(options);
    const { buildContext } = await import('../../application/context.js');
    const { hqAccess } = await import('../../application/project-hq.js');
    const access = await hqAccess(buildContext(), this.projectId, userId).catch((e: unknown) => {
      throw (e as { code?: string }).code === 'NOT_FOUND' ? refuse('not_found') : e;
    });
    if (access.status === 'rugged') throw refuse('wrong_status');
    const member = access.role !== null;
    if (!member && !this.hasMemberInside()) throw refuse('members_only');
    await super.onJoin(client, options);
    this.visitors.set(client.sessionId, {
      userId,
      member,
      joinedAt: Date.now(),
      shiftLogged: false,
    });
    if (member) await this.publishPresence();
  }

  /**
   * Log a finished HQ shift, and show visitors out after the last member.
   * @param client - The leaving client.
   */
  override onLeave(client: Client): void {
    super.onLeave(client);
    const v = this.visitors.get(client.sessionId);
    this.visitors.delete(client.sessionId);
    if (!v?.member) return;
    void this.maybeLogShift(v, Date.now());
    if (!this.hasMemberInside()) {
      for (const c of [...this.clients]) {
        if (this.visitors.get(c.sessionId)?.member === false) c.leave(4403, 'members_only');
      }
    }
    void this.publishPresence();
  }

  /**
   * Clear the presence set when the room closes.
   */
  override async onDispose(): Promise<void> {
    await super.onDispose();
    this.visitors.clear();
    await this.publishPresence();
  }

  private hasMemberInside(): boolean {
    for (const v of this.visitors.values()) if (v.member) return true;
    return false;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const v of this.visitors.values()) if (v.member) await this.maybeLogShift(v, now);
    await this.publishPresence();
  }

  private async maybeLogShift(v: Visitor, now: number): Promise<void> {
    if (v.shiftLogged || now - v.joinedAt < this.shiftMs) return;
    v.shiftLogged = true;
    try {
      const { buildContext } = await import('../../application/context.js');
      const { recordHqShift } = await import('../../application/project-hq.js');
      await recordHqShift(buildContext(), this.projectId, v.userId, new Date(now));
    } catch {
      v.shiftLogged = false; // retried on the next tick
    }
  }

  private async publishPresence(): Promise<void> {
    if (this.projectId === '') return;
    try {
      const { buildContext } = await import('../../application/context.js');
      const { setHqMembersPresent } = await import('../../application/project-hq.js');
      const members = [
        ...new Set([...this.visitors.values()].filter((v) => v.member).map((v) => v.userId)),
      ];
      await setHqMembersPresent(buildContext(), this.projectId, members);
    } catch {
      // A missed refresh only delays the API's view; the room still enforces.
    }
  }
}
