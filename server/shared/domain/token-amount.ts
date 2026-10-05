/**
 * Token amount in base units, with the mint's decimals known.
 *
 * Used for SOL, USDC, SKR, ORE, and fictional coin amounts. Token
 * amounts are serialised as **strings** in base units (per the spec
 * Conventions), never as numbers, to keep precision through JSON.
 */
export interface MintInfo {
  /** Symbol, e.g. "USDC", "SOL", "SKR", "ORE". */
  symbol: string;
  /** Decimals (USDC=6, SOL=9, SKR=5/??, ORE=11). */
  decimals: number;
  /** Mainnet mint pubkey, or null for native SOL. */
  mint: string | null;
}

export class TokenAmount {
  private readonly _baseUnits: bigint;
  private readonly _mint: MintInfo;

  private constructor(baseUnits: bigint, mint: MintInfo) {
    this._baseUnits = baseUnits;
    this._mint = mint;
  }

  /**
   * Construct from a bigint, integer, or base-units string.
   * @param baseUnits - The integer base-unit amount.
   * @param mint - The mint descriptor (symbol, decimals, mint pubkey).
   */
  static of(baseUnits: bigint | number | string, mint: MintInfo): TokenAmount {
    const v =
      typeof baseUnits === 'bigint'
        ? baseUnits
        : typeof baseUnits === 'number'
          ? BigInt(Math.trunc(baseUnits))
          : BigInt(baseUnits);
    return new TokenAmount(v, mint);
  }

  /** @returns The zero amount for the given mint. */
  static zero(mint: MintInfo): TokenAmount {
    return new TokenAmount(0n, mint);
  }

  /** @returns The base-unit amount as a bigint. */
  get baseUnits(): bigint {
    return this._baseUnits;
  }

  /** @returns The mint descriptor. */
  get mint(): MintInfo {
    return this._mint;
  }

  /**
   * Add two amounts. Throws if the mints differ.
   * @param other - The TokenAmount to add.
   */
  add(other: TokenAmount): TokenAmount {
    if (other._mint.symbol !== this._mint.symbol) {
      throw new Error(`mismatched mints: ${this._mint.symbol} vs ${other._mint.symbol}`);
    }
    return new TokenAmount(this._baseUnits + other._baseUnits, this._mint);
  }

  /**
   * Subtract. Throws if the mints differ.
   * @param other - The TokenAmount to subtract.
   */
  sub(other: TokenAmount): TokenAmount {
    if (other._mint.symbol !== this._mint.symbol) {
      throw new Error(`mismatched mints: ${this._mint.symbol} vs ${other._mint.symbol}`);
    }
    return new TokenAmount(this._baseUnits - other._baseUnits, this._mint);
  }

  /**
   * Multiply by a rational basis-points factor with half-up rounding.
   * @param bps - The factor in basis points.
   */
  mulBps(bps: number | bigint): TokenAmount {
    const b = typeof bps === 'bigint' ? bps : BigInt(Math.round(bps));
    const num = this._baseUnits * b;
    const rem = num % 10000n;
    const rounded = num / 10000n + (rem >= 5000n ? 1n : 0n);
    return new TokenAmount(rounded, this._mint);
  }

  /**
   * @returns True if this amount is greater than or equal to `other`.
   * @throws If the mints differ.
   */
  gte(other: TokenAmount): boolean {
    if (other._mint.symbol !== this._mint.symbol) {
      throw new Error(`mismatched mints`);
    }
    return this._baseUnits >= other._baseUnits;
  }

  toJSON(): string {
    return this._baseUnits.toString();
  }
}

/** Well-known mints for the spec. */
export const MINTS = {
  USDC: {
    symbol: 'USDC',
    decimals: 6,
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  } as MintInfo,
  SOL: { symbol: 'SOL', decimals: 9, mint: null } as MintInfo,
  SKR: {
    symbol: 'SKR',
    decimals: 5,
    mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
  } as MintInfo,
  ORE: {
    symbol: 'ORE',
    decimals: 11,
    mint: 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp',
  } as MintInfo,
} as const;
