// Parity test: the off-chain client's EIP-712 hashing/signing must match
// contracts/HSPMandateSettlement.sol exactly. Runs against any chain
// where the settlement contract is deployed (anvil in run-demo.sh).
//
//   SETTLEMENT_CONTRACT=0x... HSK_RPC_URL=http://127.0.0.1:8545 \
//     node test/parity.test.mjs

import { JsonRpcProvider, Contract, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { loadConfig } from '../src/config.mjs';
import {
  settlementAbi,
  hashTerms,
  hashMandate,
  mandateDigest,
  signMandate,
  recoverMandateSigner,
} from '../src/hsp.mjs';

const cfg = loadConfig();
if (!cfg.settlementAddress) throw new Error('SETTLEMENT_CONTRACT not set');

const provider = new JsonRpcProvider(cfg.rpcUrl);
const { chainId } = await provider.getNetwork();
const contract = new Contract(cfg.settlementAddress, settlementAbi(), provider);

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const payer = Wallet.createRandom();
const terms = {
  payee: Wallet.createRandom().address,
  token: Wallet.createRandom().address,
  amount: 123456n,
  memoHash: keccak256(toUtf8Bytes('parity-check')),
  expiry: 9999999999n,
};
const mandate = {
  payer: payer.address,
  payee: terms.payee,
  token: terms.token,
  amount: terms.amount,
  termsHash: hashTerms(terms),
  nonce: 42n,
  deadline: 9999999999n,
};

check('hashTerms: client == contract', hashTerms(terms) === (await contract.hashTerms(terms)));
check('hashMandate: client == contract', hashMandate(mandate) === (await contract.hashMandate(mandate)));
check(
  'mandateDigest: client == contract',
  mandateDigest(Number(chainId), cfg.settlementAddress, mandate) === (await contract.mandateDigest(mandate)),
);

const sig = await signMandate(payer, Number(chainId), cfg.settlementAddress, mandate);
check(
  'signMandate recovers to payer',
  recoverMandateSigner(Number(chainId), cfg.settlementAddress, mandate, sig) === payer.address,
);

if (failures > 0) {
  console.error(`\nPARITY RESULT: FAIL (${failures} checks)`);
  process.exit(1);
}
console.log('\nPARITY RESULT: PASS — client EIP-712 model is byte-identical to the contract');
