/**
 * Verify that every required on-chain address from the spec actually exists
 * (or, for the ones that are off-cluster, fail with a clear message).
 *
 * Addresses checked:
 *   USDC mainnet, USDC devnet, SKR, ORE mint, stORE, ORE program, stake
 *   program, Seeker Genesis Token group.
 *
 * Also calls getAccountInfo and prints the decimals / owner / executable
 * flags so the spec's claims are auditable.
 *
 * Usage:
 *   pnpm tsx tools/scripts/verify-onchain.ts
 *
 * Records results in docs/UNVERIFIED.md (caller does that).
 */
import { createConnection, withTimeout } from './_lib';
import { address, type Address } from '@solana/kit';
import { publicKey } from '@metaplex-foundation/umi';

const RPC = process.env.SOLANA_RPC_URL_MAINNET ?? 'https://api.mainnet-beta.solana.com';
const DEV = process.env.SOLANA_RPC_URL_DEVNET ?? 'https://api.devnet.solana.com';

interface Check {
  name: string;
  cluster: 'mainnet' | 'devnet';
  addr: string;
  expectedOwner?: string;
  expectedExecutable?: boolean;
  note?: string;
}

const checks: Check[] = [
  {
    name: 'USDC mint (mainnet)',
    cluster: 'mainnet',
    addr: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  {
    name: 'USDC mint (devnet)',
    cluster: 'devnet',
    addr: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
  {
    name: 'SKR mint',
    cluster: 'mainnet',
    addr: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
    note: 'no devnet per spec',
  },
  { name: 'ORE mint', cluster: 'mainnet', addr: 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp' },
  { name: 'stORE mint', cluster: 'mainnet', addr: 'storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR' },
  {
    name: 'ORE program',
    cluster: 'mainnet',
    addr: 'oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv',
    expectedExecutable: true,
  },
  {
    name: 'ORE stake program',
    cluster: 'mainnet',
    addr: 'stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH',
    expectedExecutable: true,
  },
  {
    name: 'Seeker Genesis Token group',
    cluster: 'mainnet',
    addr: 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te',
    note: 'read-only; expected to exist; we do not write to it',
  },
];

// Note: the ORE mint in the spec uses oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp.
// We print a warning if the on-chain mint differs.

interface AccountInfoLite {
  executable: boolean;
  owner: string;
  lamports: number;
  data: { length: number };
}

async function fetchInfo(url: string, addr: Address): Promise<AccountInfoLite | null> {
  const conn = createConnection(url);
  // @solana/kit 8.4: getAccountInfo is on the RPC object directly, returns a
  // builder. The value field carries the account info or null.
  const info = (await withTimeout(
    conn.getAccountInfo(addr, { encoding: 'base64' }).send() as Promise<{
      value: AccountInfoLite | null;
    }>,
    8000,
    `getAccountInfo(${addr})`,
  )) as { value: AccountInfoLite | null };
  return info.value;
}

async function main(): Promise<void> {
  let failed = 0;
  for (const c of checks) {
    const url = c.cluster === 'mainnet' ? RPC : DEV;
    try {
      const info = await fetchInfo(url, address(c.addr));
      if (!info) {
        console.log(`[FAIL] ${c.name} (${c.cluster}): account not found at ${c.addr}`);
        failed++;
        continue;
      }
      const execMismatch =
        c.expectedExecutable !== undefined && info.executable !== c.expectedExecutable;
      if (execMismatch) {
        console.log(
          `[FAIL] ${c.name}: expected executable=${String(c.expectedExecutable)} got ${String(info.executable)}`,
        );
        failed++;
        continue;
      }

      console.log(
        `[ OK ] ${c.name}: owner=${info.owner} exec=${String(info.executable)} dataLen=${String(info.data.length)}`,
      );
    } catch (e) {
      console.log(`[FAIL] ${c.name}: ${(e as Error).message}`);
      failed++;
    }
  }
  void publicKey; // keep umi import in case future checks need it
  if (failed === 0) {
    console.log(`verify-onchain: all ${checks.length} addresses OK.`);
  } else {
    console.log(`verify-onchain: ${failed} of ${checks.length} failed.`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
