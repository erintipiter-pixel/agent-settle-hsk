# AgentSettle-HSK — Agent Payments & A2A Settlement via HSP

Hackathon entry for **HSK Chain Horizon (DoraHacks), Track 2 — Agent
Payments & A2A Settlement (HSP: HashKey Settlement Platform)**.
Builder persona: Erintipiter (solo).

## What it does

Implements the agent-payment flow specified by the official Track 2 brief,
in the shape of HSP (HashKey Settlement Platform — HashKey's x402-compatible
settlement protocol for AI agents, built around the *Payment Mandate*):

1. The **receiving agent** publishes payment terms (payee, token, amount,
   memo/invoice hash, expiry) — optionally anchored on-chain.
2. The **paying agent** reads the terms and creates a **Payment Mandate**
   bound to the terms hash, with a payer nonce and deadline.
3. The paying agent **signs the mandate with its wallet** (EIP-712).
4. A **gateway** relays mandate + signature; the settlement contract
   verifies terms binding, expiry, replay protection and the signature,
   then executes the on-chain payment (ERC-20 or native HSK).
5. Settlement issues an on-chain **Receipt** that anyone can verify against
   the mandate — the on-chain hash becomes the auditable financial
   document, mirroring HSP's design goal.

## Honest integration note

The official HSP developer guide is public (hashfans.io/docs?id=HSP) and
specifies the flow as **Intent → Settlement → Verification**, with a §9
REST coordinator API (sessions / intents / capability / mandate / tx /
verify / receipt / reconcile) authenticated by an organizer-issued
`X-API-Key`, plus a QA MCP gateway for the order flow. As of 28 Nov 2026
the organizer has **not yet published** the coordinator base URL or any
API key, there is **no testnet USDC on HashKey testnet yet** (the
organizer will provide a test USDC contract once their sandbox deploys),
and the QA MCP gateway is IP-allowlisted (not reachable from our network
yet). So:

- The **client implements both real wire shapes** (REST §9 + MCP order
  flow) behind one interface, with base URL / API key taken from env.
- Locally, a **mock coordinator** implements the §9 endpoints faithfully
  (same verdict rule: ACCEPT iff requiredCapabilities ⊆
  satisfiedCapabilities and the on-chain receipt verifies), relaying
  settlement to our contract on a local chain.
- On **HSK testnet** the contract is deployed and a full live flow
  (terms → signed mandate → settle → verified receipt) has run with our
  MockERC20 standing in for the organizer's test USDC; the agent wallet
  relayed its own mandate because the real Gateway is not yet reachable.
  Swapping in the real coordinator later changes only client config.

## Layout

- `contracts/HSPMandateSettlement.sol` — terms/mandate/settlement/receipt.
- `contracts/mocks/MockERC20.sol` — test-only token (stands in for a
  testnet stablecoin until the organizer publishes theirs).
- `test/HSPMandateSettlement.t.sol` — Forge tests: ERC-20 + native happy
  paths; rejection paths for bad signature, terms/amount mismatch, replay,
  and expired mandate. **7/7 pass.**
- `script/Deploy.s.sol` — Foundry deploy script (optional mock token via
  `DEPLOY_MOCK_TOKEN=1`).
- `client/` — the HSP gateway client and demo (Node + ethers):
  - `src/gateway.mjs` — one interface, two transports:
    `RestCoordinatorClient` (§9 flow) and `McpOrderClient`
    (create_order → prepare_payment → finalize_payment with a local
    EIP-712 signature → submit_payment → query_payment).
  - `src/mock-coordinator.mjs` — local §9 coordinator stand-in.
  - `src/hsp.mjs` — EIP-712 mandate model (proven byte-identical to the
    contract by `test/parity.test.mjs`) + payer-side spend caps.
  - `demo.mjs` + `run-demo.sh` — scripted local demo (ACCEPT + REJECT).
  - `scripts/deploy-testnet.mjs` — one-command HSK testnet deploy (agent
    key read in-process only).
  - `scripts/live-flow.mjs` — the live testnet flow.
  - `demo-output.log`, `live-testnet-output.log`, `deployments.json` —
    recorded run evidence.
- `docs/ARCHITECTURE.md` — flow and trust model.

## Networks

- Build/test target: **HSK Chain testnet, chainId 133**
  (RPC https://testnet.hsk.xyz). Note: the DoraHacks Agentic Payment
  Guide mentions "177 testnet" — that conflicts with the live network
  (177 is HSK **mainnet**); the live-probed testnet chainId is **133**.
- Mainnet (chainId 177) is intentionally not configured in this repo; per
  the event rules it is only a post-win claim step.

## Run the tests

```bash
forge test            # contract tests (7/7)
./client/run-demo.sh  # parity test + full local demo vs mock coordinator
```

## Local demo (mock coordinator)

```bash
./client/run-demo.sh
```

Starts anvil (chainId 133), deploys the contracts, starts the mock
coordinator, then runs the scripted flow: terms published → mandate
signed → settlement → receipt → **verify ACCEPT**, plus a **REJECT** case
(required capability `escrow` not satisfied). Output is saved to
`client/demo-output.log`. Latest run: **PASS** (parity 4/4, ACCEPT
settled + receipt verified + reconcile MATCHED, REJECT on capability
mismatch).

## Live on HSK testnet (deployed 27 Nov 2026)

- `HSPMandateSettlement`: `0x1969ac9a8d90c79C752DB2301cCedCB0570c208A`
  (deploy tx `0xf084b62d745e44106fdcd7e6e8fb657861e6302d2030d4d2ad9131388b16dfce`)
- MockERC20 (test USDC stand-in): `0x0a411D3B741A38BBD3c433924c62d6695d06d2c7`
  (deploy tx `0x09c4ebde3101bc4c95fd646ea3f6e02c8152958bd491c713dca337c82573d5f6`)
- Live flow txs (chainId 133, RPC https://testnet.hsk.xyz):
  - mint test tokens: `0xb1cc9353ce8e4c93106261434e1d2e093c6be4ee605f16fb3e439941429aed59`
  - approve settlement contract: `0xa4738a5b6d7d76e97606647243cb58c86d1426987be093e12c7c2d9d1fd48023`
  - publish terms: `0x824b818f7ca27266447a0ba79262967163e4835d634612be312c9f1715c0865a`
  - **settle** (signed Payment Mandate → payment): `0xb35fc087bf0ff82dee482f287ba23b2bddbbf2357de74a1fd5ddb028eb57e822`
    → receipt #0, `verifyReceipt` on-chain = true, payee +25.00 test tokens.
  Full log: `client/live-testnet-output.log`; machine-readable record:
  `client/deployments.json`. (A public testnet explorer was not reachable
  from our network at build time, so hashes are given raw — they verify
  against the RPC above.)

## Demo video

A ≤3-minute walkthrough (local demo ACCEPT + REJECT, then the live
testnet evidence) is produced alongside this repo as `demo.mp4`
(terminal recording + title cards). Video link:
https://www.youtube.com/watch?v=EqbWwywckus

## How to run the live demo

Against the organizer's real HSP Gateway, once they publish the sandbox:

```bash
cd client && npm install
export HSP_COORDINATOR_URL=<organizer coordinator base URL>
export HSP_API_KEY=<organizer-issued key>
export SETTLEMENT_CONTRACT=0x1969ac9a8d90c79C752DB2301cCedCB0570c208A
export TEST_USDC_ADDRESS=<organizer test USDC contract>
node demo.mjs   # same scripted flow, real coordinator + real test USDC
```

**Still organizer-gated (cannot be supplied by us):**

1. **Coordinator base URL** — the §9 gateway base URL in the guide is a
   placeholder; the real sandbox URL is not yet published.
2. **X-API-Key** — issued by the organizer; none has been issued yet.
3. **Testnet USDC contract address** — no test USDC exists on HashKey
   testnet yet; the organizer will provide one once their sandbox
   deploys. (Our MockERC20 stands in until then.)
4. **QA MCP gateway IP allowlist** — https://mcp-qa.hashkeymerchant.com/
   currently answers Cloudflare 403 from our network; the organizer must
   allowlist our egress IP (request in progress via the organizer
   channel). The MCP client is implemented and ready.

Not organizer-gated anymore: tHSK for gas (faucet claim succeeded —
agent wallet funded), contract deployment, and the full on-chain flow
(all live on testnet, see above).
