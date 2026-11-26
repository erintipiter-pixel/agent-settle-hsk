// One live end-to-end flow on HSK TESTNET (chainId 133) against the
// contracts deployed by scripts/deploy-testnet.mjs:
//
//   publish terms → build + EIP-712-sign mandate (agent wallet, key read
//   in-process) → settle() → verify receipt on-chain.
//
// The agent wallet relays its own mandate here: the organizer's real HSP
// Gateway/coordinator (which would relay + verify server-side) is not yet
// published, so on testnet the gateway role is played locally — exactly
// the stand-in documented in the README. The payee is an ephemeral
// address created for this run (mock tokens only; nothing of value).
//
//   node scripts/live-flow.mjs     (reads client/deployments.json)

import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, Contract, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { loadConfig } from '../src/config.mjs';
import { loadAgentWallet } from '../src/wallet.mjs';
import { settlementAbi, erc20Abi, hashTerms, signMandate } from '../src/hsp.mjs';

const cfg = loadConfig();
const depPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'deployments.json');
const dep = JSON.parse(fs.readFileSync(depPath, 'utf8'));
const settlementAddr = cfg.settlementAddress || dep.settlement;
const tokenAddr = cfg.tokenAddress || dep.mockToken;
if (!settlementAddr || !tokenAddr) throw new Error('deployments.json missing settlement/mockToken — deploy first');

const provider = new JsonRpcProvider(cfg.rpcUrl);
const { chainId } = await provider.getNetwork();
if (Number(chainId) !== 133) throw new Error(`expected chainId 133, got ${chainId}`);

const payer = loadAgentWallet(cfg.keyFile, provider);
const payee = Wallet.createRandom(); // ephemeral receiving agent for this run
console.log(`chain: HSK testnet 133 via ${cfg.rpcUrl}`);
console.log(`payer (agent wallet): ${payer.address}`);
console.log(`payee (ephemeral receiving agent): ${payee.address}`);
console.log(`settlement: ${settlementAddr}`);
console.log(`token (MockERC20 stand-in): ${tokenAddr}`);

const token = new Contract(tokenAddr, erc20Abi(), payer);
const settlement = new Contract(settlementAddr, settlementAbi(), payer);

const AMOUNT = 25_000000n; // 25.00 test USDC
let tx;

tx = await token.mint(payer.address, 1_000_000000n);
await tx.wait();
console.log(`mint 1000 test tokens to payer, tx: ${tx.hash}`);

tx = await token.approve(settlementAddr, 1_000_000000n);
await tx.wait();
console.log(`approve(settlement), tx: ${tx.hash}`);

const now = Math.floor(Date.now() / 1000);
const terms = {
  payee: payee.address,
  token: tokenAddr,
  amount: AMOUNT,
  memoHash: keccak256(toUtf8Bytes('invoice: live testnet demo — research-report delivery')),
  expiry: BigInt(now + 86400),
};
tx = await settlement.publishTerms(terms);
await tx.wait();
const termsHash = hashTerms(terms);
console.log(`terms published, tx: ${tx.hash}`);
console.log(`termsHash: ${termsHash}`);

const mandate = {
  payer: payer.address,
  payee: payee.address,
  token: tokenAddr,
  amount: AMOUNT,
  termsHash,
  nonce: BigInt(Date.now()),
  deadline: BigInt(now + 3600),
};
const signature = await signMandate(payer, 133, settlementAddr, mandate);
console.log('mandate signed by agent wallet (EIP-712)');

const payeeBefore = await token.balanceOf(payee.address);
tx = await settlement.settle(terms, mandate, signature);
const rc = await tx.wait();
let receiptId = null;
for (const log of rc.logs) {
  try {
    const parsed = settlement.interface.parseLog(log);
    if (parsed && parsed.name === 'PaymentSettled') receiptId = Number(parsed.args.receiptId);
  } catch { /* not our event */ }
}
console.log(`settle tx: ${tx.hash} → receipt #${receiptId}`);

const ok = await settlement.verifyReceipt(BigInt(receiptId), mandate);
const receipt = await settlement.getReceipt(BigInt(receiptId));
const payeeAfter = await token.balanceOf(payee.address);
console.log(`verifyReceipt on-chain: ${ok}`);
console.log(`receipt: payer=${receipt.payer} payee=${receipt.payee} amount=${receipt.amount} termsHash=${receipt.termsHash}`);
console.log(`payee balance delta: +${payeeAfter - payeeBefore}`);

if (!ok || payeeAfter - payeeBefore !== AMOUNT) {
  console.error('\nLIVE FLOW RESULT: FAIL');
  process.exit(1);
}
console.log('\nLIVE FLOW RESULT: PASS — terms → signed mandate → settlement → verified receipt, all on HSK testnet (133).');
