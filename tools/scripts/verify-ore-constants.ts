/**
 * Verify ORE constants exist on Solana mainnet-beta.
 * Run: pnpm tsx tools/scripts/verify-ore-constants.ts
 */
import { Connection, PublicKey } from '@solana/web3.js';

const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

const constants = {
  'ORE_MINT': 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp',
  'ORE_PROGRAM_ID': 'oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv',
  'ORE_STAKE_PROGRAM_ID': 'stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH',
  'STORE_MINT': 'storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR',
};

async function verify() {
  const conn = new Connection(MAINNET_RPC, 'confirmed');
  console.log('Verifying ORE constants on mainnet-beta...\n');

  for (const [name, address] of Object.entries(constants)) {
    try {
      const pubkey = new PublicKey(address);
      const info = await conn.getAccountInfo(pubkey);
      if (info) {
        console.log(`✅ ${name}: ${address}`);
        console.log(`   Owner: ${info.owner.toBase58()}`);
        console.log(`   Lamports: ${info.lamports}`);
        console.log(`   Executable: ${info.executable}`);
        console.log('');
      } else {
        console.log(`❌ ${name}: ${address} - ACCOUNT NOT FOUND\n`);
      }
    } catch (err) {
      console.log(`❌ ${name}: ${address} - ERROR: ${(err as Error).message}\n`);
    }
  }
}

verify().catch(console.error);
