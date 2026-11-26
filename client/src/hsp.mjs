// HSP mandate model: EIP-712 types, hashing and signing helpers that mirror
// contracts/HSPMandateSettlement.sol exactly, plus wire (JSON) conversion
// and the payer-side spend guard.
//
// The contract is the source of truth for the type strings:
//   PaymentTerms(address payee,address token,uint256 amount,bytes32 memoHash,uint256 expiry)
//   PaymentMandate(address payer,address payee,address token,uint256 amount,bytes32 termsHash,uint256 nonce,uint256 deadline)
//   EIP712Domain name "HSPAgentSettlement", version "1"
// test/parity.test.mjs proves client hashes == contract hashes on-chain.

import fs from 'node:fs';
import path from 'node:path';
import { TypedDataEncoder, verifyTypedData } from 'ethers';

export const EIP712_TYPES = {
  PaymentTerms: [
    { name: 'payee', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'memoHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
  ],
  PaymentMandate: [
    { name: 'payer', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export function domain(chainId, settlementAddress) {
  return {
    name: 'HSPAgentSettlement',
    version: '1',
    chainId,
    verifyingContract: settlementAddress,
  };
}

export function hashTerms(terms) {
  return TypedDataEncoder.hashStruct('PaymentTerms', { PaymentTerms: EIP712_TYPES.PaymentTerms }, terms);
}

export function hashMandate(mandate) {
  return TypedDataEncoder.hashStruct('PaymentMandate', { PaymentMandate: EIP712_TYPES.PaymentMandate }, mandate);
}

export function mandateDigest(chainId, settlementAddress, mandate) {
  // ethers v6: TypedDataEncoder.hash(domain, types, value) — the primary
  // type is inferred from the single-key types object.
  return TypedDataEncoder.hash(domain(chainId, settlementAddress), { PaymentMandate: EIP712_TYPES.PaymentMandate }, mandate);
}

/** Sign a PaymentMandate with the payer wallet (EIP-712). */
export async function signMandate(wallet, chainId, settlementAddress, mandate) {
  return wallet.signTypedData(
    domain(chainId, settlementAddress),
    { PaymentMandate: EIP712_TYPES.PaymentMandate },
    mandate,
  );
}

/** Recover the signer of a mandate signature (off-chain verification). */
export function recoverMandateSigner(chainId, settlementAddress, mandate, signature) {
  return verifyTypedData(
    domain(chainId, settlementAddress),
    { PaymentMandate: EIP712_TYPES.PaymentMandate },
    mandate,
    signature,
  );
}

// ------------------------------------------------------------ wire format
// JSON transport uses decimal strings for uint256 fields.

const UINT_FIELDS = new Set(['amount', 'expiry', 'nonce', 'deadline']);

export function toWire(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = UINT_FIELDS.has(k) ? v.toString() : v;
  }
  return out;
}

export function fromWire(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = UINT_FIELDS.has(k) ? BigInt(v) : v;
  }
  return out;
}

// ------------------------------------------------------------------- ABIs
// ABIs are read from the Foundry build artifacts so the client can never
// drift from the compiled contracts. Run `forge build` first.

function loadAbi(relPath, label) {
  const p = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', relPath);
  if (!fs.existsSync(p)) {
    throw new Error(`${label} artifact not found at ${relPath} — run "forge build" in repo/ first`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
}

export function settlementAbi() {
  return loadAbi('out/HSPMandateSettlement.sol/HSPMandateSettlement.json', 'HSPMandateSettlement');
}

export function erc20Abi() {
  return loadAbi('out/MockERC20.sol/MockERC20.json', 'MockERC20');
}

// ------------------------------------------------------------- spend guard

/**
 * Payer-side spend caps (per-transaction and rolling 24h), persisted to a
 * local state file. Enforced client-side before any mandate is signed.
 */
export class SpendGuard {
  constructor({ maxPerTxUnits = null, maxPerDayUnits = null, stateFile }) {
    this.maxPerTxUnits = maxPerTxUnits;
    this.maxPerDayUnits = maxPerDayUnits;
    this.stateFile = stateFile;
    this.entries = [];
    if (stateFile && fs.existsSync(stateFile)) {
      try {
        this.entries = JSON.parse(fs.readFileSync(stateFile, 'utf8')).entries || [];
      } catch {
        this.entries = [];
      }
    }
  }

  spentLast24h(now = Date.now()) {
    const cutoff = now - 24 * 3600 * 1000;
    return this.entries
      .filter((e) => e.at >= cutoff)
      .reduce((sum, e) => sum + BigInt(e.amount), 0n);
  }

  check(amount, now = Date.now()) {
    if (this.maxPerTxUnits !== null && amount > this.maxPerTxUnits) {
      throw new Error(`spend cap: amount ${amount} exceeds per-tx cap ${this.maxPerTxUnits}`);
    }
    if (this.maxPerDayUnits !== null && this.spentLast24h(now) + amount > this.maxPerDayUnits) {
      throw new Error(`spend cap: amount ${amount} exceeds remaining daily cap ${this.maxPerDayUnits}`);
    }
  }

  record(amount, now = Date.now()) {
    this.entries.push({ at: now, amount: amount.toString() });
    if (this.stateFile) {
      fs.writeFileSync(this.stateFile, JSON.stringify({ entries: this.entries }, null, 2));
    }
  }
}
