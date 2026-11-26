// Configuration for the HSP agent client.
//
// Everything environment-specific comes from env vars — gateway base URLs
// and API keys are NEVER hard-coded. See client/.env.example.
//
//   HSK_RPC_URL          JSON-RPC endpoint (default: HSK testnet)
//   HSK_CHAIN_ID         expected chain id (default: 133, HSK testnet)
//   HSP_COORDINATOR_URL  §9 REST coordinator base URL (organizer-gated)
//   HSP_API_KEY          X-API-Key for the coordinator (organizer-issued)
//   HSP_MCP_URL          QA MCP gateway (default: mcp-qa.hashkeymerchant.com)
//   SETTLEMENT_CONTRACT  deployed HSPMandateSettlement address
//   TEST_USDC_ADDRESS    ERC-20 used for settlement (organizer test USDC
//                        on HSK testnet; MockERC20 locally)
//   AGENT_KEY_FILE       path to the agent wallet key file (read
//                        in-process only, never printed)
//   MAX_PER_TX_UNITS     payer-side per-transaction spend cap (base units)
//   MAX_PER_DAY_UNITS    payer-side rolling daily spend cap (base units)

import os from 'node:os';
import path from 'node:path';

export function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    rpcUrl: env.HSK_RPC_URL || 'https://testnet.hsk.xyz',
    chainId: Number(env.HSK_CHAIN_ID || 133),
    coordinatorUrl: env.HSP_COORDINATOR_URL || '',
    apiKey: env.HSP_API_KEY || '',
    mcpUrl: env.HSP_MCP_URL || 'https://mcp-qa.hashkeymerchant.com/',
    settlementAddress: env.SETTLEMENT_CONTRACT || '',
    tokenAddress: env.TEST_USDC_ADDRESS || '',
    keyFile:
      env.AGENT_KEY_FILE ||
      path.join(os.homedir(), 'workspace/wallets/agent-evm-base.key'),
    maxPerTxUnits: env.MAX_PER_TX_UNITS ? BigInt(env.MAX_PER_TX_UNITS) : null,
    maxPerDayUnits: env.MAX_PER_DAY_UNITS ? BigInt(env.MAX_PER_DAY_UNITS) : null,
    spendStateFile:
      env.SPEND_STATE_FILE ||
      path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.spend-state.json'),
  };
  return { ...cfg, ...overrides };
}
