#!/usr/bin/env bash
# Local end-to-end demo: anvil (chainId 133) + mock HSP coordinator (§9)
# + scripted ACCEPT/REJECT flow. Output is tee'd to client/demo-output.log.
#
#   ./client/run-demo.sh
#
# Uses anvil's built-in deterministic dev accounts (public, worthless):
#   #0 deployer, #1 mock-coordinator gateway relayer, #2 payee agent.
# The PAYER is the real agent wallet (key read in-process by the client
# from AGENT_KEY_FILE), funded on the throwaway anvil chain only.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT="$REPO/client"
RPC="http://127.0.0.1:8545"
MOCK_PORT=4409
DEMO_API_KEY="local-demo-key"
AGENT_ADDR="0x75B1Ef9cFEb617e960a2AE4551Cc01bf2522111b"
ANVIL_LOG="/tmp/hsk-anvil.log"
COORD_LOG="/tmp/hsk-coordinator.log"
PIDS=""

cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  # Belt-and-braces: nothing may keep the demo ports after this script.
  fuser -k 8545/tcp 4409/tcp 2>/dev/null || true
}
trap cleanup EXIT

main() {
  cd "$REPO"
  echo "== forge build =="
  forge build --silent || { echo "forge build failed"; return 1; }

  if [ ! -d "$CLIENT/node_modules" ]; then
    echo "== npm install (client) =="
    (cd "$CLIENT" && npm install --no-audit --no-fund) || return 1
  fi

  echo "== starting anvil (chainId 133) =="
  anvil --chain-id 133 --port 8545 >"$ANVIL_LOG" 2>&1 &
  PIDS="$PIDS $!"
  for i in $(seq 1 50); do
    grep -q "Listening on" "$ANVIL_LOG" 2>/dev/null && break
    sleep 0.2
  done
  # Parse anvil's printed dev accounts (addresses + keys) from its log.
  mapfile -t ADDRS < <(awk '/Available Accounts/{f=1;next} /Private Keys/{f=0} f' "$ANVIL_LOG" | grep -oE '0x[0-9a-fA-F]{40}')
  mapfile -t KEYS < <(awk '/Private Keys/{f=1;next} /Mnemonic/{f=0} f' "$ANVIL_LOG" | grep -oE '0x[0-9a-fA-F]{64}')
  DEPLOYER="${ADDRS[0]}"; GATEWAY_KEY="${KEYS[1]}"; PAYEE_ADDR="${ADDRS[2]}"; PAYEE_KEY="${KEYS[2]}"
  echo "deployer: $DEPLOYER"
  echo "payee agent: $PAYEE_ADDR"
  echo "payer (agent wallet): $AGENT_ADDR"

  echo "== deploying contracts to anvil =="
  DEPLOY_MOCK_TOKEN=1 forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast \
    --private-key "${KEYS[0]}" --silent || { echo "deploy failed"; return 1; }
  read -r SETTLEMENT TOKEN < <(node -e '
    const j = require(process.argv[1]);
    const get = (n) => j.transactions.find((t) => t.contractName === n)?.contractAddress;
    console.log(get("HSPMandateSettlement"), get("MockERC20"));' \
    "$REPO/broadcast/Deploy.s.sol/133/run-latest.json")
  echo "settlement: $SETTLEMENT"
  echo "mock token: $TOKEN"

  echo "== funding agent wallet on anvil =="
  cast rpc anvil_setBalance "$AGENT_ADDR" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null || return 1
  cast send "$TOKEN" "mint(address,uint256)" "$AGENT_ADDR" 1000000000 \
    --private-key "${KEYS[0]}" --rpc-url "$RPC" >/dev/null || return 1
  echo "agent funded: 100 ETH (anvil) + 1000 mock tokens"

  echo "== starting mock coordinator on :$MOCK_PORT =="
  (cd "$CLIENT" && exec env MOCK_PORT=$MOCK_PORT HSK_RPC_URL="$RPC" SETTLEMENT_CONTRACT="$SETTLEMENT" \
    GATEWAY_PRIVATE_KEY="$GATEWAY_KEY" HSP_API_KEY="$DEMO_API_KEY" \
    node src/mock-coordinator.mjs) >"$COORD_LOG" 2>&1 </dev/null &
  PIDS="$PIDS $!"
  for i in $(seq 1 50); do
    curl -s -o /dev/null "http://127.0.0.1:$MOCK_PORT/sessions/nope" -H "X-API-Key: $DEMO_API_KEY" && break
    sleep 0.2
  done
  cat "$COORD_LOG"

  export HSK_RPC_URL="$RPC" SETTLEMENT_CONTRACT="$SETTLEMENT" TEST_USDC_ADDRESS="$TOKEN"
  export HSP_COORDINATOR_URL="http://127.0.0.1:$MOCK_PORT" HSP_API_KEY="$DEMO_API_KEY"

  echo "== parity test (client EIP-712 vs contract) =="
  (cd "$CLIENT" && node test/parity.test.mjs) || return 1

  echo "== scripted demo (ACCEPT + REJECT) =="
  (cd "$CLIENT" && PAYEE_PRIVATE_KEY="$PAYEE_KEY" MAX_PER_TX_UNITS=50000000 node demo.mjs) || return 1
}

main > "$CLIENT/demo-output.log" 2>&1
RC=$?
cat "$CLIENT/demo-output.log"
exit $RC
