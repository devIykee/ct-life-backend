/**
 * Operational tool for CT Life refund obligations and dispute resolution.
 * Allows the operator to inspect pending refund obligations and submit executed refund transaction hashes for reconciliation.
 *
 * Usage:
 *   pnpm tsx tools/scripts/manage-refunds.ts list
 *   pnpm tsx tools/scripts/manage-refunds.ts reconcile <orderId> <refundTransactionHash>
 */
import { buildContext } from '../../server/application/context.js';
import { EconomyOrders } from '../../server/application/economy-orders.js';
import { createEconomyChain } from '../../server/application/economy-chain.js';
import { createEconomyHttpRpc } from '../../server/application/economy-chain-rpc.js';

async function main(): Promise<void> {
  const [action, arg1, arg2] = process.argv.slice(2);
  const ctx = buildContext();
  const db = ctx.db;

  if (action === 'list') {
    const res = await db.pool.query(`
      SELECT
        r.receipt_id,
        r.order_id,
        r.chain_id,
        r.event_id,
        r.transaction_id AS incoming_tx,
        r.recorded_at,
        o.user_id,
        o.payer AS user_wallet,
        o.recipient AS merchant_wallet,
        o.asset_id,
        o.amount_base_units,
        o.status AS order_status
      FROM economy_receipts r
      JOIN economy_orders o USING (order_id)
      WHERE r.disposition = 'refund_due'
      ORDER BY r.recorded_at ASC
    `);

    if (res.rows.length === 0) {
      console.log('✅ No pending refund obligations. All orders clean.');
      process.exit(0);
    }

    console.log(`📋 Found ${res.rows.length} pending refund obligation(s):\n`);
    for (const row of res.rows) {
      console.log(`Order ID:      ${row.order_id}`);
      console.log(`Receipt ID:    ${row.receipt_id}`);
      console.log(`User ID:       ${row.user_id}`);
      console.log(`Chain:         ${row.chain_id}`);
      console.log(`Asset:         ${row.asset_id}`);
      console.log(`Amount:        ${row.amount_base_units} (base units)`);
      console.log(`Refund To:     ${row.user_wallet}`);
      console.log(`Refund From:   ${row.merchant_wallet}`);
      console.log(`Original Tx:   ${row.incoming_tx}`);
      console.log(`Order Status:  ${row.order_status}`);
      console.log(`Recorded At:   ${row.recorded_at}`);
      console.log('---------------------------------------------------------');
    }
    process.exit(0);
  }

  if (action === 'reconcile') {
    const orderId = arg1;
    const refundTxHash = arg2;

    if (!orderId || !refundTxHash) {
      console.error('Usage: pnpm tsx tools/scripts/manage-refunds.ts reconcile <orderId> <refundTransactionHash>');
      process.exit(1);
    }

    const orderRes = await db.pool.query<{ user_id: string }>(
      'SELECT user_id FROM economy_orders WHERE order_id = $1',
      [orderId],
    );
    const firstRow = orderRes.rows[0];
    if (!firstRow) {
      console.error(`Order ${orderId} not found`);
      process.exit(1);
    }
    const userId = firstRow.user_id;

    console.log(`🔍 Verifying and reconciling refund for order ${orderId} with tx ${refundTxHash}...`);

    const rpc = createEconomyHttpRpc({
      rpcUrls: {
        'solana:mainnet': process.env.ECONOMY_RPC_SOLANA || '',
        'eip155:4663': process.env.ECONOMY_RPC_ROBINHOOD || 'https://rpc.mainnet.chain.robinhood.com',
        'near:mainnet': process.env.ECONOMY_RPC_NEAR || 'https://free.rpc.fastnear.com',
      },
    });
    const chain = createEconomyChain({ rpc });
    const ordersService = new EconomyOrders(ctx, chain);

    const result = await ordersService.record(userId, orderId, refundTxHash, 'refund');
    console.log('Result:', JSON.stringify(result, null, 2));

    if (result.status === 'refunded') {
      console.log(`✅ Refund successfully verified and reconciled on-chain! Order status is now ${result.status}.`);
      console.log(`Refund transaction ID: ${result.refundTransactionId}`);
    } else {
      console.log(`ℹ️ Order status is currently ${result.status}. Remaining refund obligations: ${result.refundDueReceiptIds.length}`);
    }
    process.exit(0);
  }

  console.log('CT Life Refund Obligations Manager');
  console.log('Usage:');
  console.log('  pnpm tsx tools/scripts/manage-refunds.ts list');
  console.log('  pnpm tsx tools/scripts/manage-refunds.ts reconcile <orderId> <refundTransactionHash>');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
