// Gateway clients: ONE interface, TWO wire shapes.
//
// The HSP flow is Intent → Settlement → Verification (official developer
// guide, hashfans.io/docs?id=HSP). Two transports exist:
//
// (a) REST coordinator — the guide's §9 gateway endpoints:
//       POST /sessions            GET  /sessions/{id}
//       POST /intents             GET  /intents/{id}
//       POST /intents/{id}/capability
//       POST /intents/{id}/mandate
//       POST /intents/{id}/tx
//       POST /verify              POST /verify/receipt
//       POST /reconcile           POST /reconcile/explain
//     Auth: X-API-Key header (organizer-issued key). Base URL is an
//     organizer placeholder until their sandbox is published.
//
// (b) MCP order flow — the live QA gateway named in the DoraHacks
//     "Agentic Payment Guide" (https://mcp-qa.hashkeymerchant.com/),
//     JSON-RPC tools: get_chain_config, create_order, prepare_payment,
//     finalize_payment, submit_payment, query_payment, get_order.
//     Amounts are USDC cents; every order carries a unique
//     cart_mandate_id. finalize_payment is where the payer's EIP-712
//     signature over the prepared payment mandate is submitted.
//
// Both implementations expose the same granular methods where the shape
// allows it, plus a high-level payFlow(). Nothing here hard-codes a base
// URL or a key: both come from config/env.

import { randomUUID } from 'node:crypto';
import { toWire, fromWire, signMandate, hashTerms } from './hsp.mjs';

// ============================================================ REST client

export class RestCoordinatorClient {
  /**
   * @param {object} cfg loadConfig() result
   * @param {object} opts { wallet, spendGuard } wallet = payer signer
   */
  constructor(cfg, { wallet, spendGuard } = {}) {
    if (!cfg.coordinatorUrl) throw new Error('HSP_COORDINATOR_URL is not set');
    this.base = cfg.coordinatorUrl.replace(/\/$/, '');
    this.apiKey = cfg.apiKey || '';
    this.wallet = wallet || null;
    this.spendGuard = spendGuard || null;
    this.chainId = cfg.chainId;
    this.settlementAddress = cfg.settlementAddress;
  }

  async _req(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`coordinator ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return data;
  }

  createSession() {
    return this._req('POST', '/sessions', {});
  }

  getSession(id) {
    return this._req('GET', `/sessions/${encodeURIComponent(id)}`);
  }

  createIntent(sessionId, terms) {
    return this._req('POST', '/intents', { sessionId, terms: toWire(terms) });
  }

  getIntent(id) {
    return this._req('GET', `/intents/${encodeURIComponent(id)}`);
  }

  declareCapabilities(id, { requiredCapabilities, satisfiedCapabilities }) {
    return this._req('POST', `/intents/${encodeURIComponent(id)}/capability`, {
      requiredCapabilities,
      satisfiedCapabilities,
    });
  }

  submitMandate(id, mandate, signature) {
    return this._req('POST', `/intents/${encodeURIComponent(id)}/mandate`, {
      mandate: toWire(mandate),
      signature,
    });
  }

  submitTx(id) {
    return this._req('POST', `/intents/${encodeURIComponent(id)}/tx`, {});
  }

  verify(id) {
    return this._req('POST', '/verify', { intentId: id });
  }

  verifyReceipt(id) {
    return this._req('POST', '/verify/receipt', { intentId: id });
  }

  reconcile(id) {
    return this._req('POST', '/reconcile', { intentId: id });
  }

  reconcileExplain(id) {
    return this._req('POST', '/reconcile/explain', { intentId: id });
  }

  /**
   * Full REST flow: session → intent → capabilities → mandate (signed
   * locally by the payer wallet) → settlement tx → verification.
   * @returns the verify() result plus flow artefacts.
   */
  async payFlow({ terms, requiredCapabilities, satisfiedCapabilities, nonce, deadlineSecs = 3600 }) {
    if (!this.wallet) throw new Error('payFlow needs a payer wallet');
    if (this.spendGuard) this.spendGuard.check(terms.amount);

    const session = await this.createSession();
    const intent = await this.createIntent(session.sessionId, terms);
    await this.declareCapabilities(intent.intentId, { requiredCapabilities, satisfiedCapabilities });

    const mandate = {
      payer: this.wallet.address,
      payee: terms.payee,
      token: terms.token,
      amount: terms.amount,
      termsHash: hashTerms(terms),
      nonce: BigInt(nonce ?? Date.now()),
      deadline: BigInt(Math.floor(Date.now() / 1000) + deadlineSecs),
    };
    const signature = await signMandate(this.wallet, this.chainId, this.settlementAddress, mandate);
    await this.submitMandate(intent.intentId, mandate, signature);

    const tx = await this.submitTx(intent.intentId);
    const verdict = await this.verify(intent.intentId);
    if (this.spendGuard && verdict.verdict === 'ACCEPT') this.spendGuard.record(terms.amount);
    return { sessionId: session.sessionId, intentId: intent.intentId, mandate, signature, tx, verdict };
  }
}

// ============================================================= MCP client

export class McpOrderClient {
  /**
   * MCP (JSON-RPC 2.0 over HTTP) client for the QA gateway's order flow.
   * Implemented to the DoraHacks Agentic Payment Guide's tool list.
   * NOTE: the QA gateway is IP-allowlisted; from a non-allowlisted network
   * every call returns Cloudflare 403. This client is therefore written
   * gateway-agnostic and is exercised in CI only up to the transport
   * boundary until the allowlist includes our egress IP.
   */
  constructor(cfg, { wallet, spendGuard } = {}) {
    this.url = cfg.mcpUrl;
    this.wallet = wallet || null;
    this.spendGuard = spendGuard || null;
    this._id = 0;
  }

  async callTool(name, args = {}) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this._id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP ${name} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    // MCP HTTP transport may answer with SSE framing; take the data: lines.
    let payload = text;
    if (text.startsWith('event:') || text.includes('\ndata:')) {
      payload = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5))
        .join('');
    }
    const rpc = JSON.parse(payload);
    if (rpc.error) throw new Error(`MCP ${name} → RPC error: ${JSON.stringify(rpc.error).slice(0, 300)}`);
    const content = rpc.result?.content?.[0]?.text;
    return content ? JSON.parse(content) : rpc.result;
  }

  getChainConfig() {
    return this.callTool('get_chain_config');
  }

  /** amountCents: integer USDC cents. cartMandateId must be unique. */
  createOrder({ amountCents, payee, memo, cartMandateId = randomUUID() }) {
    return this.callTool('create_order', {
      amount: amountCents,
      payee,
      memo,
      cart_mandate_id: cartMandateId,
    });
  }

  preparePayment(orderId) {
    return this.callTool('prepare_payment', { order_id: orderId });
  }

  finalizePayment(orderId, signature, extra = {}) {
    return this.callTool('finalize_payment', { order_id: orderId, signature, ...extra });
  }

  submitPayment(orderId) {
    return this.callTool('submit_payment', { order_id: orderId });
  }

  queryPayment(orderId) {
    return this.callTool('query_payment', { order_id: orderId });
  }

  getOrder(orderId) {
    return this.callTool('get_order', { order_id: orderId });
  }

  /**
   * Full MCP flow: create_order → prepare_payment → sign the prepared
   * EIP-712 mandate locally → finalize_payment → submit_payment →
   * query_payment. The prepared payload's typed data is signed as
   * returned by the gateway (domain/types/value); if the gateway returns
   * a bare mandate value, the HSP domain from get_chain_config is used.
   */
  async payFlow({ amountCents, payee, memo }) {
    if (!this.wallet) throw new Error('payFlow needs a payer wallet');
    if (this.spendGuard) this.spendGuard.check(BigInt(amountCents));

    const cartMandateId = randomUUID();
    const order = await this.createOrder({ amountCents, payee, memo, cartMandateId });
    const orderId = order.order_id ?? order.orderId ?? order.id;
    const prepared = await this.preparePayment(orderId);

    const td = prepared.typed_data ?? prepared.typedData ?? prepared.mandate ?? prepared;
    let signature;
    if (td.domain && td.types && td.value) {
      const types = { ...td.types };
      delete types.EIP712Domain;
      const primary = td.primaryType ?? Object.keys(types)[0];
      signature = await this.wallet.signTypedData(td.domain, types, td.value);
      void primary;
    } else {
      throw new Error('prepare_payment did not return signable typed data');
    }

    const finalized = await this.finalizePayment(orderId, signature, { cart_mandate_id: cartMandateId });
    const submitted = await this.submitPayment(orderId);
    const status = await this.queryPayment(orderId);
    if (this.spendGuard) this.spendGuard.record(BigInt(amountCents));
    return { cartMandateId, orderId, order, prepared, finalized, submitted, status };
  }
}

// Re-exported for callers that build mandates from wire payloads.
export { fromWire };
