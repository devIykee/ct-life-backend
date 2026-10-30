/**
 * Bot client.
 *
 * Real-keypair headless client. Each bot:
 *
 *   1. Generates a Solana keypair locally.
 *   2. Calls `POST /v1/auth/dev { wallet }` to mint a session.
 *   3. Walks through Phase 1 endpoints: character create, lottery
 *      roll (one try; ALREADY_ROLLED on retry is OK), join the
 *      timeline_square venue via Colyseus, send a `say` and an
 *      `emote`, and start a shift.
 *
 * The bot is wired to the same REST + realtime servers the game
 * uses. The bot keypair is never funded; dev auth bypasses the
 * SIWS flow.
 */
import { Keypair } from '@solana/web3.js';
import { Client as ColyseusClient } from '@colyseus/sdk';

export interface BotOptions {
  readonly apiBase: string;
  readonly wsBase: string;
  readonly venueId: string;
  readonly name?: string;
}

export interface BotResult {
  readonly wallet: string;
  userId: string;
  joinedVenue: boolean;
  characterCreated: boolean;
  rolledLottery: boolean;
  shiftStarted: boolean;
  ranM5Flow: boolean;
}

interface DevAuthResponse {
  readonly id: string;
  readonly wallet: string;
  readonly accessToken: string;
}

interface LotteryResponse {
  readonly outcome: 'seeker' | 'insider' | 'exit_liquidity';
  readonly cashCents: number;
  readonly homeId: string;
}

interface ShiftResponse {
  readonly shiftId: string;
  readonly endsAt: string;
}

interface IntentResponse {
  readonly intentId: string;
  readonly reference: string;
}

interface PredictionResponse {
  readonly predictionId: string;
}

function idempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class Bot {
  private readonly keypair: Keypair;
  private readonly opts: BotOptions;
  private accessToken: string | null = null;
  private userId: string | null = null;

  constructor(opts: BotOptions) {
    this.keypair = Keypair.generate();
    this.opts = opts;
  }

  get wallet(): string {
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Run the full Phase 1 bot flow. Each step catches its own
   * errors and returns a partial result; the test asserts which
   * steps succeeded.
   */
  async run(): Promise<BotResult> {
    const r: BotResult = {
      wallet: this.wallet,
      userId: '',
      joinedVenue: false,
      characterCreated: false,
      rolledLottery: false,
      shiftStarted: false,
      ranM5Flow: false,
    };
    // 1. Dev auth.
    const auth = await this.devAuth().catch(() => null);
    if (!auth) return r;
    this.accessToken = auth.accessToken;
    this.userId = auth.id;
    r.userId = auth.id;

    // 2. Character.
    r.characterCreated = await this.createCharacter().catch(() => false);

    // 3. Lottery.
    r.rolledLottery = await this.rollLottery().catch(() => false);

    // 4. Venue.
    r.joinedVenue = await this.joinVenue().catch(() => false);

    // 5. Shift start.
    r.shiftStarted = await this.startShift().catch(() => false);

    // M5 flows: drive the city-life endpoints in sequence.
    r.ranM5Flow =
      (await this.purchaseCosmeticBot().catch(() => false)) ||
      (await this.dailyClueBot().catch(() => false)) ||
      (await this.runGigBot().catch(() => false)) ||
      (await this.seasonPassBot().catch(() => false)) ||
      (await this.foundBusinessBot().catch(() => false));

    return r;
  }

  private async devAuth(): Promise<DevAuthResponse> {
    const res = await fetch(`${this.opts.apiBase}/v1/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey('dev') },
      body: JSON.stringify({ wallet: this.wallet }),
    });
    if (!res.ok) throw new Error(`dev auth ${res.status}`);
    return (await res.json()) as DevAuthResponse;
  }

  private async createCharacter(): Promise<boolean> {
    const res = await fetch(`${this.opts.apiBase}/v1/characters`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('char'),
      },
      body: JSON.stringify({
        alias: `bot-${this.wallet.slice(0, 6).toLowerCase()}`,
        look: {
          skinTone: '#f5d0a9',
          headId: 'head_default',
          hairId: 'hair_short',
          topId: 'top_hoodie',
          bottomId: 'bottom_jeans',
          shoesId: 'shoes_sneakers',
          accId: 'acc_none',
        },
        traitIds: ['trait_a', 'trait_b'],
        dreamId: 'dream_hacker',
        tribeId: 'trencher',
        ageConfirmed: true,
      }),
    });
    return res.ok;
  }

  private async rollLottery(): Promise<boolean> {
    const res = await fetch(`${this.opts.apiBase}/v1/lottery/roll`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('lottery'),
      },
    });
    if (!res.ok) {
      // 409 ALREADY_ROLLED is acceptable; the test still counts
      // the roll as attempted.
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      if (body?.error?.code === 'ALREADY_ROLLED') return true;
      return false;
    }
    const r = (await res.json()) as LotteryResponse;
    return r.outcome !== undefined;
  }

  private async joinVenue(): Promise<boolean> {
    const client = new ColyseusClient(this.opts.wsBase);
    const room = await client.joinOrCreate('venue', {
      venueId: this.opts.venueId,
      token: this.accessToken,
    });
    await new Promise((r) => room.onMessage('welcome', () => r(undefined)));
    // Send a say and an emote.
    room.send('say', { text: 'gm from bot' });
    room.send('emote', { emoteId: 'emote_wave' });
    await new Promise((r) => setTimeout(r, 200));
    await room.leave();
    return true;
  }

  private async startShift(): Promise<boolean> {
    const res = await fetch(`${this.opts.apiBase}/v1/shifts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('shift'),
      },
      body: JSON.stringify({ careerId: 'discord_mod' }),
    });
    if (!res.ok) return false;
    const r = (await res.json()) as ShiftResponse;
    return Boolean(r.shiftId);
  }

  /** M3: create a topup intent. Returns the intentId (no on-chain leg in dev). */
  async createTopup(): Promise<string | null> {
    const res = await fetch(`${this.opts.apiBase}/v1/payments/intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('topup'),
      },
      body: JSON.stringify({ kind: 'topup', currency: 'USDC', sku: 'ramen' }),
    });
    if (!res.ok) return null;
    const r = (await res.json()) as IntentResponse;
    return r.intentId;
  }

  /** Unlock D3: bet `yes` on the first open Prediction Pit market (null when none). */
  async betOnPrediction(stakeCents: number): Promise<string | null> {
    const list = await fetch(`${this.opts.apiBase}/v1/predictions/markets?status=open`, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    });
    if (!list.ok) return null;
    const { markets } = (await list.json()) as { markets: Array<{ marketId: string }> };
    const market = markets[0];
    if (!market) return null;
    const url = `${this.opts.apiBase}/v1/predictions/markets/${encodeURIComponent(market.marketId)}/bets`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('pred'),
      },
      body: JSON.stringify({ outcomeId: 'yes', stakeCents }),
    });
    if (!res.ok) return null;
    const r = (await res.json()) as PredictionResponse;
    return r.predictionId;
  }

  /**
   * M4: tip a peer (cash tip). Returns the tip row or null on
   * failure (insufficient cash is the common reason).
   */
  async tipBot(toWallet: string, amountCents: number): Promise<boolean> {
    void toWallet; // M4 tip endpoint takes toUserId (uuid), not wallet. Use int(userId).
    const res = await fetch(`${this.opts.apiBase}/v1/tips`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('tip'),
      },
      body: JSON.stringify({ toUserId: this.opts.venueId === 'tip-any' ? '' : '', amountCents }),
    });
    void res;
    return false; // The full M4 #57 path requires two-user setup; placeholder.
  }

  /** M4: create a home (kind). */
  async createHome(kind: string): Promise<boolean> {
    const res = await fetch(`${this.opts.apiBase}/v1/homes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('home'),
      },
      body: JSON.stringify({ kind }),
    });
    return res.ok;
  }

  /** M4: visit another player's home. */
  async visitHome(ownerId: string, homeId: string): Promise<boolean> {
    void ownerId;
    const res = await fetch(`${this.opts.apiBase}/v1/homes/${encodeURIComponent(homeId)}/visit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('visit'),
      },
      body: '{}',
    });
    return res.ok;
  }

  /** M4: create a Space, optionally join it. */
  async startSpaceBot(title: string): Promise<string | null> {
    const res = await fetch(`${this.opts.apiBase}/v1/spaces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('space'),
      },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) return null;
    const r = (await res.json()) as { spaceId: string };
    return r.spaceId;
  }

  /** M4: raise hand in a Space. */
  async raiseHand(spaceId: string): Promise<boolean> {
    const res = await fetch(`${this.opts.apiBase}/v1/spaces/${encodeURIComponent(spaceId)}/hand`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('hand'),
      },
    });
    return res.ok;
  }

  /** M4: end a Space (host only). */
  async endSpace(spaceId: string): Promise<boolean> {
    const res = await fetch(`${this.opts.apiBase}/v1/spaces/${encodeURIComponent(spaceId)}/end`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('end-space'),
      },
    });
    return res.ok;
  }

  /** M5: list the cosmetic shop and buy one item. */
  async purchaseCosmeticBot(): Promise<boolean> {
    const listRes = await fetch(`${this.opts.apiBase}/v1/shop`, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    });
    if (!listRes.ok) return false;
    const list = (await listRes.json()) as {
      items: Array<{ itemId: string; onchainOnly: boolean }>;
    };
    const item = list.items.find((i) => !i.onchainOnly);
    if (!item) return false;
    const res = await fetch(`${this.opts.apiBase}/v1/shop/purchase`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('cosmetic'),
      },
      body: JSON.stringify({ itemId: item.itemId }),
    });
    return res.ok;
  }

  /** M5: buy the season pass. */
  async seasonPassBot(): Promise<boolean> {
    const res = await fetch(`${this.opts.apiBase}/v1/season-pass/buy`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('season-pass'),
      },
    });
    return res.ok;
  }

  /** M5: submit a daily-clue answer. The bot tries a few candidates. */
  async dailyClueBot(): Promise<boolean> {
    const candidates = ['q', '7', 'tokyo', '1989', '2', 'mars', '88', 'au', 'paris', 'gold'];
    for (const c of candidates) {
      const res = await fetch(`${this.opts.apiBase}/v1/daily-clue/answer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.accessToken}`,
          'idempotency-key': idempotencyKey(`clue-${c}`),
        },
        body: JSON.stringify({ attempt: c }),
      });
      if (res.ok) return true;
      // 403 already_attempted -> bail.
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      if (body.error?.code === 'FORBIDDEN') return false;
    }
    return false;
  }

  /** M5: run a gig (food_delivery by default). */
  async runGigBot(gigId: string = 'food_delivery'): Promise<boolean> {
    const res = await fetch(`${this.opts.apiBase}/v1/gigs/${encodeURIComponent(gigId)}/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey(`gig-${gigId}`),
      },
      body: JSON.stringify({}),
    });
    return res.ok;
  }

  /** M5: found a business. */
  async foundBusinessBot(kind: string = 'lemonade_stand'): Promise<boolean> {
    const res = await fetch(`${this.opts.apiBase}/v1/businesses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('business'),
      },
      body: JSON.stringify({ kind }),
    });
    return res.ok;
  }

  /** M5: found a project + hire a bot. */
  async foundProjectBot(): Promise<boolean> {
    const fRes = await fetch(`${this.opts.apiBase}/v1/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.accessToken}`,
        'idempotency-key': idempotencyKey('project-found'),
      },
      body: JSON.stringify({ kind: 'memecoin' }),
    });
    if (!fRes.ok) return false;
    const fJson = (await fRes.json()) as { projectId: string };
    // Hire a random (any) user UUID; the test seed users are
    // uuidv7() so a fresh UUID will 23505 the unique hire
    // index. The bot's run is logged for the load test but
    // not asserted on the second bot's UUID match.
    const hireRes = await fetch(
      `${this.opts.apiBase}/v1/projects/${encodeURIComponent(fJson.projectId)}/hire`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.accessToken}`,
          'idempotency-key': idempotencyKey('project-hire'),
        },
        body: JSON.stringify({
          userId: this.userId ?? '',
          role: 'dev',
          salaryCentsPerWeek: 1000,
        }),
      },
    );
    return hireRes.ok;
  }
}
