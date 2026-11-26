// Scripted end-to-end demo of the HSP flow against the LOCAL mock
// coordinator (§9 endpoints) and HSPMandateSettlement on a local anvil
// chain (chainId 133, mirroring HSK testnet):
//
//   terms published → mandate signed → settlement → receipt →
//   verify ACCEPT, plus one REJECT case (capability mismatch).
//
// The payer is the real agent wallet (key read in-process from
// AGENT_KEY_FILE, funded on anvil only). The payee is a local anvil
// account. Run via client/run-demo.sh, which sets all env vars.

import { JsonRpcProvider, Contract, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { loadConfig } from './src/config.mjs';
import { loadAgentWallet } from './src/wallet.mjs';
import { RestCoordinatorClient } from './src/gateway.mjs';
import { settlementAbi, erc20Abi, hashTerms, SpendGuard } from './src/hsp.mjs';

const cfg = loadConfig();
const fail = (msg) => {
  console.error(`\nDEMO RESULT: FAIL — ${msg}`);
  process.exit(1);
};
const section = (t) => console.log(`\n=== ${t} ===`);

const provider = new JsonRpcProvider(cfg.rpcUrl);
const { chainId } = await provider.getNetwork();
console.log(`chain: ${cfg.rpcUrl} (chainId ${chainId})`);
if (Number(chainId) !== cfg.chainId) fail(`expected chainId ${cfg.chainId}, got ${chainId}`);
if (!cfg.settlementAddress || !cfg.tokenAddress) fail('SETTLEMENT_CONTRACT / TEST_USDC_ADDRESS not set');

const payer = loadAgentWallet(cfg.keyFile, provider);
const payee = new Wallet(process.env.PAYEE_PRIVATE_KEY, provider);
console.log(`payer (agent wallet): ${payer.address}`);
console.log(`payee (receiving agent): ${payee.address}`);
console.log(`settlement contract: ${cfg.settlementAddress}`);
console.log(`token (test USDC stand-in): ${cfg.tokenAddress}`);

const token = new Contract(cfg.tokenAddress, erc20Abi(), payer);
const settlement = new Contract(cfg.settlementAddress, settlementAbi(), payer);

const payerBalance = await token.balanceOf(payer.address);
console.log(`payer token balance: ${payerBalance}`);
if (payerBalance < 30_000000n) fail('payer underfunded for the demo (needs >= 30 tokens)');

// Payer approves the settlement contract to pull the payment.
const allowance = await token.allowance(payer.address, cfg.settlementAddress);
if (allowance < 30_000000n) {
  const tx = await token.approve(cfg.settlementAddress, 1_000_000000n);
  await tx.wait();
  console.log(`approve(settlement) tx: ${tx.hash}`);
}

const spendGuard = new SpendGuard({
  maxPerTxUnits: cfg.maxPerTxUnits,
  maxPerDayUnits: cfg.maxPerDayUnits,
  stateFile: null, // demo runs are ephemeral
});
const client = new RestCoordinatorClient(cfg, { wallet: payer, spendGuard });

const now = Math.floor(Date.now() / 1000);
const nonceBase = BigInt(Math.floor(Math.random() * 1_000_000_000));

// ------------------------------------------------------------ ACCEPT flow
section('ACCEPT case — capabilities satisfied, receipt verifies');
const terms1 = {
  payee: payee.address,
  token: cfg.tokenAddress,
  amount: 25_000000n, // 25.00 test USDC
  memoHash: keccak256(toUtf8Bytes('invoice: research-report delivery, task #42')),
  expiry: BigInt(now + 86400),
};
const payeeSettlement = settlement.connect(payee);
const pubTx = await payeeSettlement.publishTerms(terms1);
await pubTx.wait();
console.log(`terms published on-chain by payee, tx: ${pubTx.hash}`);
console.log(`termsHash: ${hashTerms(terms1)}`);

const payeeBefore = await token.balanceOf(payee.address);
const accept = await client.payFlow({
  terms: terms1,
  requiredCapabilities: ['payment', 'verification', 'identity'],
  satisfiedCapabilities: ['payment', 'verification', 'identity'],
  nonce: nonceBase,
});
console.log(`session: ${accept.sessionId}`);
console.log(`intent: ${accept.intentId}`);
console.log(`mandate signed by payer (EIP-712), nonce ${accept.mandate.nonce}`);
console.log(`settlement tx: ${accept.tx.txHash} → receipt #${accept.tx.receiptId}`);
console.log(`verifier verdict: ${accept.verdict.verdict} (capabilities ${accept.verdict.capabilityVerdict}, receiptVerified=${accept.verdict.receiptVerified})`);
if (accept.verdict.verdict !== 'ACCEPT') fail('ACCEPT case did not return ACCEPT');

const receiptCheck = await client.verifyReceipt(accept.intentId);
console.log(`verify/receipt: verified=${receiptCheck.verified}, amount=${receiptCheck.receipt.amount}, payer=${receiptCheck.receipt.payer}`);
if (!receiptCheck.verified) fail('receipt did not verify');

const rec = await client.reconcile(accept.intentId);
const expl = await client.reconcileExplain(accept.intentId);
console.log(`reconcile: ${rec.status}`);
console.log(`reconcile/explain: ${expl.explanation}`);
if (rec.status !== 'MATCHED') fail('reconcile did not return MATCHED');

const payeeAfter1 = await token.balanceOf(payee.address);
console.log(`payee balance delta: +${payeeAfter1 - payeeBefore}`);
if (payeeAfter1 - payeeBefore !== terms1.amount) fail('payee did not receive the ACCEPT-case amount');

// ------------------------------------------------------------ REJECT flow
section('REJECT case — required capability "escrow" not satisfied');
const terms2 = {
  payee: payee.address,
  token: cfg.tokenAddress,
  amount: 5_000000n, // 5.00 test USDC
  memoHash: keccak256(toUtf8Bytes('invoice: escrowed milestone payment, task #43')),
  expiry: BigInt(now + 86400),
};
const pubTx2 = await payeeSettlement.publishTerms(terms2);
await pubTx2.wait();
console.log(`terms published on-chain by payee, tx: ${pubTx2.hash}`);

const reject = await client.payFlow({
  terms: terms2,
  requiredCapabilities: ['payment', 'verification', 'escrow'],
  satisfiedCapabilities: ['payment', 'verification'],
  nonce: nonceBase + 1n,
});
console.log(`intent: ${reject.intentId}`);
console.log(`settlement tx: ${reject.tx.txHash} → receipt #${reject.tx.receiptId}`);
console.log(`verifier verdict: ${reject.verdict.verdict} (capabilities ${reject.verdict.capabilityVerdict}, missing=[${reject.verdict.missingCapabilities.join(', ')}], receiptVerified=${reject.verdict.receiptVerified})`);
if (reject.verdict.verdict !== 'REJECT') fail('REJECT case did not return REJECT');
if (!reject.verdict.missingCapabilities.includes('escrow')) fail('REJECT case did not report missing "escrow"');

console.log('\nDEMO RESULT: PASS — ACCEPT flow settled + verified; REJECT flow rejected on capability mismatch (escrow).');
