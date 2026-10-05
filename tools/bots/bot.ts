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

function idempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class Bot {
  private readonly keypair: Keypair;
  private readonly opts: BotOptions;
  private accessToken: string | null = null;

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
    };
    // 1. Dev auth.
    const auth = await this.devAuth().catch(() => null);
    if (!auth) return r;
    this.accessToken = auth.accessToken;
    r.userId = auth.id;

    // 2. Character.
    r.characterCreated = await this.createCharacter().catch(() => false);

    // 3. Lottery.
    r.rolledLottery = await this.rollLottery().catch(() => false);

    // 4. Venue.
    r.joinedVenue = await this.joinVenue().catch(() => false);

    // 5. Shift start.
    r.shiftStarted = await this.startShift().catch(() => false);

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
}
