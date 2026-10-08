/**
 * AMM quote math.
 *
 * Constant-product AMM (x*y=k) with integer floor division. Used
 * by the market engine and the Terminal Cafe trade service. The
 * rounding direction is the spec's default; the protocol keeps
 * the dust.
 */

/**
 * Quote a trade against the constant-product AMM.
 *
 * `x` is the base-units reserve (token units with their decimals);
 * `y` is the quote reserve in cents (100 cents = $1 USDC).
 *
 * - buy:  pay `amountIn` in cents, receive base units out.
 *   y' = y + amountIn;  x' = x * y / y';  amountOut = x - x'.
 * - sell: pay `amountIn` base units, receive cents out.
 *   x' = x + amountIn;  usdc = y * amountIn / x';  amountOut = usdc.
 *
 * @param side - 'buy' or 'sell'.
 * @param amountIn - Cents for buy, base units for sell.
 * @param reserves - The current {x, y} reserves (x: base units, y: cents).
 * @returns The output amount and the post-trade reserves.
 */
export function ammQuote(
  side: 'buy' | 'sell',
  amountIn: bigint,
  reserves: { x: bigint; y: bigint },
): { amountOut: bigint; newX: bigint; newY: bigint } {
  if (amountIn <= 0n) throw new Error('amountIn must be > 0');
  if (reserves.x <= 0n || reserves.y <= 0n) throw new Error('reserves must be > 0');
  if (side === 'buy') {
    const newY = reserves.y + amountIn;
    const newX = (reserves.x * reserves.y) / newY;
    const amountOut = reserves.x - newX;
    return { amountOut, newX, newY };
  }
  const newX = reserves.x + amountIn;
  const newUsdc = (reserves.y * amountIn) / newX;
  return { amountOut: newUsdc, newX, newY: reserves.y - newUsdc };
}
