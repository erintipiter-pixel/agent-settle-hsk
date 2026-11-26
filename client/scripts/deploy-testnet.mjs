// Deploy HSPMandateSettlement to HSK TESTNET (chainId 133).
//
//   node scripts/deploy-testnet.mjs
//
// The agent key is read in-process from AGENT_KEY_FILE (never printed).
// The script refuses to run on any other chain id, and aborts if the
// agent wallet holds 0 tHSK. With DEPLOY_MOCK_TOKEN=1 it also deploys
// the test-only MockERC20 (stand-in until the organizer publishes their
// testnet USDC contract). Results are written to client/deployments.json.

import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, ContractFactory } from 'ethers';
import { loadConfig } from '../src/config.mjs';
import { loadAgentWallet } from '../src/wallet.mjs';

const cfg = loadConfig();
if (cfg.chainId !== 133) throw new Error(`refusing to deploy: HSK_CHAIN_ID=${cfg.chainId}, expected 133 (testnet)`);

const provider = new JsonRpcProvider(cfg.rpcUrl);
const { chainId } = await provider.getNetwork();
if (Number(chainId) !== 133) throw new Error(`RPC reports chainId ${chainId}, expected 133 — aborting`);

const wallet = loadAgentWallet(cfg.keyFile, provider);
const balance = await provider.getBalance(wallet.address);
console.log(`deployer (agent wallet): ${wallet.address}`);
console.log(`balance: ${balance} wei tHSK`);
if (balance === 0n) throw new Error('agent wallet holds 0 tHSK — fund it from the faucet first');

function artifact(rel) {
  const p = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', rel);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const bytecode = typeof j.bytecode === 'string' ? j.bytecode : j.bytecode.object;
  return { abi: j.abi, bytecode };
}

const out = { chainId: 133, rpc: cfg.rpcUrl, deployer: wallet.address, at: new Date().toISOString() };

const sArt = artifact('out/HSPMandateSettlement.sol/HSPMandateSettlement.json');
const settlement = await new ContractFactory(sArt.abi, sArt.bytecode, wallet).deploy();
await settlement.waitForDeployment();
out.settlement = await settlement.getAddress();
out.settlementDeployTx = settlement.deploymentTransaction().hash;
console.log(`HSPMandateSettlement: ${out.settlement} (tx ${out.settlementDeployTx})`);

if (process.env.DEPLOY_MOCK_TOKEN === '1') {
  const tArt = artifact('out/MockERC20.sol/MockERC20.json');
  const token = await new ContractFactory(tArt.abi, tArt.bytecode, wallet).deploy();
  await token.waitForDeployment();
  out.mockToken = await token.getAddress();
  out.mockTokenDeployTx = token.deploymentTransaction().hash;
  console.log(`MockERC20 (test USDC stand-in): ${out.mockToken} (tx ${out.mockTokenDeployTx})`);
}

const dest = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'deployments.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(`wrote ${dest}`);
