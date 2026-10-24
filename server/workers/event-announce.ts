/**
 * Event announcer.
 *
 * A BullMQ repeatable job (`jobs-event-announce`, every minute) tells the
 * city when a real event starts and ends:
 *
 *   starts_at <= now < ends_at   -> city broadcast `event_live`
 *   now >= ends_at (after live)  -> city broadcast `event_ended`
 *
 * A sweep, not a delayed job per event, because ops can move the dates with
 * PUT /v1/admin/events/{slug}; the sweep always reads the current row. Each
 * announcement is claimed first in `event_announcements` (primary key
 * event+kind), so it is sent once even with several workers or a repeated
 * sweep. A worker that was down past an event's end sends nothing for it
 * (no stale `event_live`). Clients that join later read
 * `GET /v1/events/current`.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { ensureEventsSynced } from '../application/events.js';
import { publishToUser } from '../application/realtime-bus.js';

export const EVENT_ANNOUNCE_QUEUE = 'jobs-event-announce';

interface Due {
  id: string;
  slug: string;
  title: string;
  kind: string;
  city: string;
  skin_id: string;
  ingame_venue_id: string;
  stream_url: string | null;
  ends_at: Date;
}

/**
 * Announce every event that has started or ended since the last sweep.
 * @param ctx - The app context.
 * @param now - The clock (injectable for tests).
 * @returns How many `event_live` and `event_ended` messages were sent.
 */
export async function announceEvents(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<{ live: number; ended: number }> {
  await ensureEventsSynced(ctx.db);
  const cols = `id, slug, title, kind, city, skin_id, ingame_venue_id, stream_url, ends_at`;
  const { starting, ending } = await ctx.db.withConnection(async (c) => {
    const s = await c.query<Due>(
      `SELECT ${cols} FROM events e
        WHERE starts_at <= $1 AND ends_at > $1
          AND NOT EXISTS (SELECT 1 FROM event_announcements a WHERE a.event_id = e.id AND a.kind = 'live')`,
      [now],
    );
    const e = await c.query<Due>(
      `SELECT ${cols} FROM events e
        WHERE ends_at <= $1
          AND EXISTS (SELECT 1 FROM event_announcements a WHERE a.event_id = e.id AND a.kind = 'live')
          AND NOT EXISTS (SELECT 1 FROM event_announcements a WHERE a.event_id = e.id AND a.kind = 'ended')`,
      [now],
    );
    return { starting: s.rows, ending: e.rows };
  });

  let live = 0;
  let ended = 0;
  for (const ev of starting) {
    if (!(await claim(ctx, ev.id, 'live', now))) continue;
    await publishToUser(ctx, '*', 'event_live', {
      slug: ev.slug,
      title: ev.title,
      kind: ev.kind,
      city: ev.city,
      skinId: ev.skin_id,
      ingameVenueId: ev.ingame_venue_id,
      streamUrl: ev.stream_url,
      endsAt: ev.ends_at.getTime(),
      at: now.getTime(),
    });
    live += 1;
  }
  for (const ev of ending) {
    if (!(await claim(ctx, ev.id, 'ended', now))) continue;
    await publishToUser(ctx, '*', 'event_ended', {
      slug: ev.slug,
      title: ev.title,
      kind: ev.kind,
      skinId: ev.skin_id,
      endedAt: ev.ends_at.getTime(),
      at: now.getTime(),
    });
    ended += 1;
  }
  return { live, ended };
}

async function claim(
  ctx: AppContext,
  eventId: string,
  kind: 'live' | 'ended',
  now: Date,
): Promise<boolean> {
  const r = await ctx.db.withConnection(async (c) =>
    c.query(
      `INSERT INTO event_announcements (event_id, kind, announced_at) VALUES ($1, $2, $3)
       ON CONFLICT (event_id, kind) DO NOTHING RETURNING 1`,
      [eventId, kind, now],
    ),
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * BullMQ handler for `jobs-event-announce`. Errors are logged, not thrown:
 * the next minute's sweep is the retry.
 * @param _job - The repeatable job.
 * @param ctx - The app context.
 */
export async function handleEventAnnounce(_job: Job, ctx: AppContext): Promise<void> {
  try {
    await announceEvents(ctx);
  } catch (e) {
    console.error('[event-announce] sweep failed:', (e as Error).message);
  }
}
