/**
 * Verify ORE constants exist on mainnet-beta.
 * Run with: pnpm tsx tools/scripts/verify-ore-constants.ts
 */
import { Connection, PublicKey } from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');

const constants = {
  'ORE mint': 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp',
  'ORE program': 'oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv',
  'ORE stake program': 'stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH',
  'stORE mint': 'storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR',
};

async function main(): Promise<void> {
  console.log('Verifying ORE constants on mainnet-beta...\n');
  let allExist = true;

  for (const [name, addr] of Object.entries(constants)) {
    try {
      const pubkey = new PublicKey(addr);
      const info = await conn.getAccountInfo(pubkey);
      if (info) {
        console.log(
          `✓ ${name.padEnd(20)}: ${addr} (${info.lamports} lamports, owner: ${info.owner.toBase58().slice(0, 8)}...)`,
        );
      } else {
        console.log(`✗ ${name.padEnd(20)}: ${addr} (NOT FOUND)`);
        allExist = false;
      }
    } catch (e) {
      console.log(`✗ ${name.padEnd(20)}: ${addr} (ERROR: ${(e as Error).message})`);
      allExist = false;
    }
  }

  console.log(allExist ? '\n✓ All constants verified' : '\n✗ Some constants missing');
  process.exit(allExist ? 0 : 1);
}

main().catch((e: Error) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
