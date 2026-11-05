import { ValidationFailedError } from '../shared/domain/errors.js';
import { ECONOMY_ORE, ECONOMY_WIF, type EconomyChainId } from './economy-chain.js';

export interface EconomyAsset {
  readonly chainId: EconomyChainId;
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
}

const ASSETS: readonly (EconomyAsset & { readonly bits: number })[] = [
  { chainId: 'eip155:4663', assetId: ECONOMY_WIF, symbol: 'WIF', decimals: 18, bits: 256 },
  { chainId: 'near:mainnet', assetId: 'native', symbol: 'NEAR', decimals: 24, bits: 128 },
  { chainId: 'solana:mainnet', assetId: 'native', symbol: 'SOL', decimals: 9, bits: 64 },
  { chainId: 'solana:mainnet', assetId: ECONOMY_ORE, symbol: 'ORE', decimals: 11, bits: 64 },
];

/** Resolve one allowlisted asset and validate its exact integer denomination. */
export function economyAsset(chainId: string, assetId: string, amount: string): EconomyAsset {
  const asset = ASSETS.find((a) => a.chainId === chainId && a.assetId === assetId);
  if (!asset || !/^[1-9][0-9]{0,77}$/.test(amount) || BigInt(amount) >= 1n << BigInt(asset.bits)) {
    throw new ValidationFailedError({ reason: 'invalid_economy_asset_or_amount' });
  }
  const { bits: _bits, ...publicAsset } = asset;
  return publicAsset;
}
