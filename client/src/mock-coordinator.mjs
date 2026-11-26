// Local MOCK coordinator implementing the HSP guide's §9 gateway
// endpoints, so the full Intent → Settlement → Verification flow runs
// end-to-end locally against HSPMandateSettlement on an anvil chain.
//
// This is a stand-in for the organizer's (not yet published) coordinator:
// same endpoint shapes, same X-API-Key auth header, same verdict rule —
// the Verifier returns ACCEPT iff requiredCapabilities ⊆
// satisfiedCapabilities AND the on-chain receipt verifies against the
// mandate; otherwise REJECT with the missing capabilities listed.
//
// Env:
//   MOCK_PORT            listen port (default 4409)
//   HSK_RPC_URL          chain RPC (anvil for the local demo)
//   SETTLEMENT_CONTRACT  deployed HSPMandateSettlement address
//   GATEWAY_PRIVATE_KEY  relayer key that broadcasts settle() — in the
//                        local demo this is an anvil dev account key
//                        (public, deterministic, worthless). On the real
//                        gateway this role belongs to the organizer.
//   HSP_API_KEY          if set, requests must carry this X-API-Key

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { settlementAbi, fromWire, hashTerms, recoverMandateSigner } from './hsp.mjs';

const PORT = Number(process.env.MOCK_PORT || 4409);
const RPC = process.env.HSK_RPC_URL || 'http://127.0.0.1:8545';
const SETTLEMENT = process.env.SETTLEMENT_CONTRACT || '';
const API_KEY = process.env.HSP_API_KEY || '';
if (!SETTLEMENT) throw new Error('SETTLEMENT_CONTRACT is required');
if (!process.env.GATEWAY_PRIVATE_KEY) throw new Error('GATEWAY_PRIVATE_KEY is required');

const provider = new JsonRpcProvider(RPC);
const gatewayWallet = new Wallet(process.env.GATEWAY_PRIVATE_KEY, provider);
const contract = new Contract(SETTLEMENT, settlementAbi(), gatewayWallet);
const { chainId } = await provider.getNetwork();
const CHAIN_ID = Number(chainId);

const sessions = new Map();
const intents = new Map();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function missingCaps(intent) {
  const sat = new Set(intent.satisfiedCapabilities);
  return intent.requiredCapabilities.filter((c) => !sat.has(c));
}

async function receiptVerified(intent) {
  if (intent.receiptId === null || !intent.mandate) return false;
  try {
    return await contract.verifyReceipt(BigInt(intent.receiptId), intent.mandate);
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
      return send(res, 401, { error: 'missing or invalid X-API-Key' });
    }
    const url = new URL(req.url, 'http://localhost');
    const seg = url.pathname.split('/').filter(Boolean);
    const body = req.method === 'POST' ? await readBody(req) : {};

    // ---------------------------------------------------------- sessions
    if (req.method === 'POST' && url.pathname === '/sessions') {
      const sessionId = randomUUID();
      sessions.set(sessionId, { sessionId, createdAt: new Date().toISOString(), intents: [] });
      return send(res, 201, { sessionId, createdAt: sessions.get(sessionId).createdAt });
    }
    if (req.method === 'GET' && seg[0] === 'sessions' && seg[1]) {
      const s = sessions.get(seg[1]);
      return s ? send(res, 200, s) : send(res, 404, { error: 'unknown session' });
    }

    // ----------------------------------------------------------- intents
    if (req.method === 'POST' && url.pathname === '/intents') {
      const terms = fromWire(body.terms);
      const intentId = randomUUID();
      const intent = {
        intentId,
        sessionId: body.sessionId || null,
        terms,
        termsHash: hashTerms(terms),
        requiredCapabilities: ['payment', 'verification'],
        satisfiedCapabilities: [],
        mandate: null,
        signature: null,
        txHash: null,
        receiptId: null,
        state: 'CREATED',
        createdAt: new Date().toISOString(),
      };
      intents.set(intentId, intent);
      if (intent.sessionId && sessions.has(intent.sessionId)) {
        sessions.get(intent.sessionId).intents.push(intentId);
      }
      return send(res, 201, { intentId, termsHash: intent.termsHash, state: intent.state });
    }
    if (req.method === 'GET' && seg[0] === 'intents' && seg[1] && seg.length === 2) {
      const it = intents.get(seg[1]);
      return it
        ? send(res, 200, { ...it, terms: undefined, termsHash: it.termsHash, state: it.state })
        : send(res, 404, { error: 'unknown intent' });
    }
    if (req.method === 'POST' && seg[0] === 'intents' && seg[2] === 'capability') {
      const it = intents.get(seg[1]);
      if (!it) return send(res, 404, { error: 'unknown intent' });
      if (Array.isArray(body.requiredCapabilities)) it.requiredCapabilities = body.requiredCapabilities;
      if (Array.isArray(body.satisfiedCapabilities)) it.satisfiedCapabilities = body.satisfiedCapabilities;
      it.state = 'CAPABILITY_DECLARED';
      return send(res, 200, {
        intentId: it.intentId,
        requiredCapabilities: it.requiredCapabilities,
        satisfiedCapabilities: it.satisfiedCapabilities,
        missingCapabilities: missingCaps(it),
      });
    }
    if (req.method === 'POST' && seg[0] === 'intents' && seg[2] === 'mandate') {
      const it = intents.get(seg[1]);
      if (!it) return send(res, 404, { error: 'unknown intent' });
      const mandate = fromWire(body.mandate);
      // The mandate must be bound to this intent's terms…
      if (mandate.termsHash !== it.termsHash) {
        return send(res, 422, { error: 'mandate termsHash does not match intent terms' });
      }
      const eqAddr = (a, b) => a.toLowerCase() === b.toLowerCase();
      if (
        !eqAddr(mandate.payee, it.terms.payee) ||
        !eqAddr(mandate.token, it.terms.token) ||
        mandate.amount !== it.terms.amount
      ) {
        return send(res, 422, { error: 'mandate fields do not match intent terms' });
      }
      // …and signed by the payer it names.
      let signer;
      try {
        signer = recoverMandateSigner(CHAIN_ID, SETTLEMENT, mandate, body.signature);
      } catch {
        return send(res, 422, { error: 'unrecoverable mandate signature' });
      }
      if (signer.toLowerCase() !== mandate.payer.toLowerCase()) {
        return send(res, 422, { error: 'mandate signature does not recover to payer' });
      }
      it.mandate = mandate;
      it.signature = body.signature;
      it.state = 'MANDATE_SIGNED';
      return send(res, 200, { intentId: it.intentId, state: it.state, signer });
    }
    if (req.method === 'POST' && seg[0] === 'intents' && seg[2] === 'tx') {
      const it = intents.get(seg[1]);
      if (!it) return send(res, 404, { error: 'unknown intent' });
      if (!it.mandate || !it.signature) return send(res, 409, { error: 'no signed mandate on this intent' });
      if (it.state === 'SETTLED') {
        return send(res, 200, { intentId: it.intentId, txHash: it.txHash, receiptId: it.receiptId, state: it.state });
      }
      try {
        const tx = await contract.settle(it.terms, it.mandate, it.signature);
        const rc = await tx.wait();
        it.txHash = tx.hash;
        // receiptId = PaymentSettled.receiptId, else receiptCount-1
        let rid = null;
        for (const log of rc.logs) {
          try {
            const parsed = contract.interface.parseLog(log);
            if (parsed && parsed.name === 'PaymentSettled') rid = Number(parsed.args.receiptId);
          } catch { /* not our event */ }
        }
        if (rid === null) rid = Number(await contract.receiptCount()) - 1;
        it.receiptId = rid;
        it.state = 'SETTLED';
        return send(res, 200, { intentId: it.intentId, txHash: it.txHash, receiptId: it.receiptId, state: it.state });
      } catch (e) {
        it.state = 'SETTLEMENT_FAILED';
        return send(res, 502, { error: `settlement failed: ${e.shortMessage || e.message}` });
      }
    }

    // -------------------------------------------------------- verification
    if (req.method === 'POST' && url.pathname === '/verify') {
      const it = intents.get(body.intentId);
      if (!it) return send(res, 404, { error: 'unknown intent' });
      const missing = missingCaps(it);
      const receiptOk = await receiptVerified(it);
      const verdict = missing.length === 0 && receiptOk ? 'ACCEPT' : 'REJECT';
      return send(res, 200, {
        intentId: it.intentId,
        verdict,
        capabilityVerdict: missing.length === 0 ? 'SATISFIED' : 'UNSATISFIED',
        missingCapabilities: missing,
        receiptVerified: receiptOk,
        receiptId: it.receiptId,
        txHash: it.txHash,
      });
    }
    if (req.method === 'POST' && url.pathname === '/verify/receipt') {
      const it = intents.get(body.intentId);
      if (!it) return send(res, 404, { error: 'unknown intent' });
      const ok = await receiptVerified(it);
      let receipt = null;
      if (it.receiptId !== null) {
        const r = await contract.getReceipt(BigInt(it.receiptId));
        receipt = {
          mandateHash: r.mandateHash,
          payer: r.payer,
          payee: r.payee,
          token: r.token,
          amount: r.amount.toString(),
          termsHash: r.termsHash,
          settledAt: Number(r.settledAt),
        };
      }
      return send(res, 200, { intentId: it.intentId, verified: ok, receiptId: it.receiptId, receipt });
    }

    // --------------------------------------------------------- reconcile
    if (req.method === 'POST' && (url.pathname === '/reconcile' || url.pathname === '/reconcile/explain')) {
      const it = intents.get(body.intentId);
      if (!it) return send(res, 404, { error: 'unknown intent' });
      let status = 'NOT_SETTLED';
      let detail = 'no settlement recorded for this intent';
      if (it.receiptId !== null) {
        const r = await contract.getReceipt(BigInt(it.receiptId));
        const eqAddr = (a, b) => a.toLowerCase() === b.toLowerCase();
        const matches =
          eqAddr(r.payee, it.terms.payee) && eqAddr(r.token, it.terms.token) && r.amount === it.terms.amount &&
          r.termsHash === it.termsHash;
        status = matches ? 'MATCHED' : 'MISMATCHED';
        detail = matches
          ? `on-chain receipt #${it.receiptId} matches the intent terms (payee, token, amount, termsHash)`
          : `on-chain receipt #${it.receiptId} diverges from the intent terms`;
      }
      if (url.pathname === '/reconcile') return send(res, 200, { intentId: it.intentId, status });
      return send(res, 200, {
        intentId: it.intentId,
        status,
        explanation:
          `Intent ${it.intentId} is in state ${it.state}. ${detail}. ` +
          `Capabilities required [${it.requiredCapabilities.join(', ')}], satisfied [${it.satisfiedCapabilities.join(', ')}], ` +
          `missing [${missingCaps(it).join(', ') || 'none'}]. Settlement tx: ${it.txHash || 'none'}.`,
      });
    }

    return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`mock HSP coordinator listening on :${PORT} (chain ${CHAIN_ID}, settlement ${SETTLEMENT})`);
});
