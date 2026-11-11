/**
 * WIF on Robinhood Chain live RPC & payment verification test.
 * Verifies Robinhood Chain (eip155:4663), WIF contract bytecode & decimals,
 * payment preparation, and finalized block query.
 *
 * Usage:
 *   pnpm tsx tools/scripts/test-robinhood-wif-payment.ts
 */
import { createEconomyHttpRpc } from '../../server/application/economy-chain-rpc.js';
import { createEconomyChain, ECONOMY_WIF } from '../../server/application/economy-chain.js';

async function main(): Promise<void> {
  console.log('======================================================');
  console.log('🪙 CT Life - Robinhood Chain WIF Integration Test');
  console.log('======================================================\n');

  const robinhoodRpc = process.env.ECONOMY_RPC_ROBINHOOD || 'https://rpc.mainnet.chain.robinhood.com';
  console.log(`Connecting to Robinhood Chain RPC: ${robinhoodRpc}`);

  const rpc = createEconomyHttpRpc({
    rpcUrls: {
      'eip155:4663': robinhoodRpc,
    },
    timeoutMs: 15_000,
  });

  // Step 1: Chain ID check
  console.log('1. Checking eth_chainId...');
  const chainIdHex = await rpc('eip155:4663', 'eth_chainId', []);
  const chainIdDec = parseInt(chainIdHex as string, 16);
  console.log(`   -> Chain ID: ${chainIdHex} (${chainIdDec})`);
  if (chainIdHex !== '0x1237' || chainIdDec !== 4663) {
    throw new Error(`Unexpected chain ID: expected 0x1237 (4663), got ${chainIdHex}`);
  }
  console.log('   ✅ Robinhood Chain confirmed (4663).');

  // Step 2: WIF contract verification
  console.log(`\n2. Verifying WIF contract at ${ECONOMY_WIF}...`);
  const [code, decimalsHex] = await Promise.all([
    rpc('eip155:4663', 'eth_getCode', [ECONOMY_WIF, 'latest']),
    rpc('eip155:4663', 'eth_call', [{ to: ECONOMY_WIF, data: '0x313ce567' }, 'latest']),
  ]);

  if (typeof code !== 'string' || code === '0x' || code.length < 10) {
    throw new Error(`No contract bytecode found at WIF address ${ECONOMY_WIF}`);
  }
  console.log(`   -> Contract code length: ${code.length} chars (deployed bytecode verified)`);

  const decimals = parseInt(decimalsHex as string, 16);
  console.log(`   -> WIF decimals: ${decimals}`);
  if (decimals !== 18) {
    throw new Error(`Unexpected WIF decimals: expected 18, got ${decimals}`);
  }
  console.log('   ✅ WIF contract bytecode & 18 decimals verified on Robinhood Chain.');

  // Step 3: Latest finalized block
  console.log('\n3. Querying latest finalized block on Robinhood Chain...');
  const rawFinalBlock = await rpc('eip155:4663', 'eth_getBlockByNumber', ['finalized', false]);
  if (!rawFinalBlock || typeof rawFinalBlock !== 'object') {
    throw new Error('Could not retrieve finalized block from Robinhood Chain');
  }
  const block = rawFinalBlock as { number: string; hash: string; timestamp: string };
  const blockNumber = parseInt(block.number, 16);
  const blockTimestamp = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
  console.log(`   -> Finalized Block: #${blockNumber}`);
  console.log(`   -> Block Hash:      ${block.hash}`);
  console.log(`   -> Block Timestamp: ${blockTimestamp}`);
  console.log('   ✅ Finalized state stream operational.');

  // Step 4: Prepare Payment validation
  console.log('\n4. Testing preparePayment for an in-game WIF purchase...');
  const economyChain = createEconomyChain({ rpc });
  const testPayer = '0x1111111111111111111111111111111111111111';
  const testRecipient = '0x2222222222222222222222222222222222222222';
  const testAmountBaseUnits = '1000000000000000000'; // 1.0 WIF

  const prepared = await economyChain.preparePayment({
    chainId: 'eip155:4663',
    assetId: ECONOMY_WIF,
    payer: testPayer,
    recipient: testRecipient,
    amountBaseUnits: testAmountBaseUnits,
    reference: 'test-order-12345',
    notBeforeMs: Date.now() - 60_000,
    notAfterMs: Date.now() + 600_000,
  });

  console.log('   Prepared Payment:', JSON.stringify(prepared, null, 2));
  if (prepared.kind !== 'evm' || prepared.transaction.to !== ECONOMY_WIF) {
    throw new Error('Failed to prepare valid EVM transaction for WIF');
  }
  console.log('   ✅ preparePayment produced valid ERC20 transfer payload for Robinhood Chain.');

  console.log('\n======================================================');
  console.log('🎉 Robinhood Chain WIF integration is 100% operational!');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('\n❌ Robinhood WIF test failed:', err);
  process.exit(1);
});
