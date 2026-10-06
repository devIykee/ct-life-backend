import { Keypair, Transaction } from '@solana/web3.js';
import { buildOreStakeTx } from '../../server/shared/solana/ore-stake.ts';

for (const action of ['deposit', 'withdraw', 'claim', 'compound'] as const) {
  const user = Keypair.generate().publicKey;
  const tx = buildOreStakeTx({ userPubkey: user, action, amount: 1_000_000n });
  console.log(action, 'instructions:', tx.instructions.length);
}
