# Architecture

## Flow

```
Payee agent                Payer agent                 Gateway (relayer)            HSPMandateSettlement (HSK testnet)
    |                          |                             |                                  |
    |-- payment terms -------->|                             |                                  |
    |   (payee, token, amount, |                             |                                  |
    |    memoHash, expiry)     |                             |                                  |
    |                          |-- Payment Mandate --------->|                                  |
    |                          |   bound to hash(terms),     |                                  |
    |                          |   EIP-712 wallet signature  |                                  |
    |                          |                             |-- settle(terms, mandate, sig) -->|
    |                          |                             |     verify terms binding         |
    |                          |                             |     verify expiry + nonce        |
    |                          |                             |     verify payer signature       |
    |                          |                             |     transfer token / native HSK  |
    |<------------------------- payment ---------------------|                                  |
    |                          |                             |     store Receipt + event        |
    |                          |<----- receipt id -----------|                                  |
    |         anyone: verifyReceipt(receiptId, mandate) ---->|--> true / false                  |
```

## Trust model

- The payer's EIP-712 signature is the only authorization. The gateway is a
  dumb relayer: it cannot alter amount, payee, token or terms without
  invalidating the signature or the terms-hash binding.
- Terms binding is double-checked: `mandate.termsHash == hashTerms(terms)`
  AND the mandate's payee/token/amount must equal the terms' fields — a
  mandate created against cheaper terms cannot be settled against richer
  ones.
- Replay protection is two-layered: a consumed mandate hash can never
  settle twice, and a payer nonce can never be reused.
- Signatures are malleability-guarded (EIP-2 low-s, v ∈ {27, 28}).
- Receipts are append-only and bind mandate hash, parties, amount and
  terms hash; verification recomputes the mandate hash from the mandate
  itself, so no trust in the gateway or either agent is required.

## Relation to HSP

HSP (HashKey Settlement Platform) is HashKey's production, x402-compatible
settlement protocol for AI agents; its published design centers on the
Payment Mandate and on turning on-chain hashes into auditable financial
documents. This project implements that documented flow on HSK Chain. The
on-chain half (mandate verification, settlement, receipt) is real and
deployed on HSK testnet. The client implements both official wire shapes
(the guide's §9 REST coordinator API and the QA MCP order flow); locally
they run against a faithful mock coordinator because the organizer has not
yet published the coordinator base URL / API key or a testnet USDC
contract, and the QA gateway is IP-allowlisted (see repo README, "Honest
integration note"). Swapping in the real gateway is a config change, not
a code change.
