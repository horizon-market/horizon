import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PaymentsConfig } from '../config.js';

/** x402 v2 `exact` requirements for the Hedera creation charge. Trading never uses this path. */
export type PaymentRequirements = {
  scheme: 'exact'; network: string; amount: string; payTo: string; maxTimeoutSeconds: number; asset: string;
  extra: { feePayer?: string; nonce: string; assetDecimals: number; settlementMode: PaymentsConfig['mode'] };
};

export type PaymentResource = { url: string; description: string; mimeType: 'application/json' };

export const payloadSchema = z.object({
  x402Version: z.literal(2),
  resource: z.object({ url: z.string().url(), description: z.string().optional(), mimeType: z.string().optional() }).strict().optional(),
  accepted: z.object({
    scheme: z.literal('exact'), network: z.string().min(1).max(64), asset: z.string().min(1).max(128),
    amount: z.string().regex(/^\d+$/), payTo: z.string().min(1).max(128), maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.string(), z.unknown()),
  }).strict(),
  payload: z.record(z.string(), z.unknown()),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type PaymentPayload = z.infer<typeof payloadSchema>;

export class PaymentPayloadError extends Error {}
export class PaymentRejectedError extends Error {
  constructor(readonly reason: string) { super('payment_rejected'); }
}
/** The facilitator outcome is unknown; never charge again without reconciliation. */
export class SettlementAmbiguousError extends Error {
  constructor(readonly reason: string) { super('settlement_ambiguous'); }
}

export function paymentNonce(): string { return randomBytes(16).toString('hex'); }
export function payloadFingerprint(header: string): string { return createHash('sha256').update(header).digest('hex'); }

export function buildRequirements(config: PaymentsConfig, input: { amountUnits: bigint; nonce: string }): PaymentRequirements {
  if (!config.payTo) throw new Error('payment_receiver_not_configured');
  return {
    scheme: 'exact', network: config.network, amount: input.amountUnits.toString(),
    payTo: config.payTo, maxTimeoutSeconds: config.timeoutSeconds, asset: config.asset,
    extra: { nonce: input.nonce, assetDecimals: config.assetDecimals, settlementMode: config.mode },
  };
}

export function decodePayment(header: string): PaymentPayload {
  if (header.length > 8192) throw new PaymentPayloadError('payment_payload_too_large');
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
  catch { throw new PaymentPayloadError('payment_payload_unreadable'); }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) throw new PaymentPayloadError('payment_payload_invalid');
  return parsed.data;
}

export type VerifyResult = { valid: boolean; payer?: string; reason?: string };
export type SettleResult = { transaction: string; payer?: string; network: string; mode: PaymentsConfig['mode'] };

export interface PaymentFacilitator {
  readonly name: string;
  readonly mode: PaymentsConfig['mode'];
  prepare(requirements: PaymentRequirements): Promise<PaymentRequirements>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult>;
}

const settleSchema = z.object({
  success: z.boolean(), transaction: z.string().min(1).max(256).optional(),
  network: z.string().optional(), payer: z.string().max(128).optional(), errorReason: z.string().max(256).optional(),
  errorMessage: z.string().max(512).optional(),
});

function facilitatorError(body: unknown, fallback: string): string {
  const parsed = z.object({
    message: z.union([z.string(), z.array(z.string())]).optional(),
    error: z.string().optional(), errorReason: z.string().optional(), errorMessage: z.string().optional(),
  }).passthrough().safeParse(body);
  if (!parsed.success) return fallback;
  const message = Array.isArray(parsed.data.message) ? parsed.data.message.join(', ') : parsed.data.message;
  return (parsed.data.errorMessage ?? parsed.data.errorReason ?? message ?? parsed.data.error ?? fallback).slice(0, 180);
}

/** Real Blocky402 client. Errors are reported as such; nothing is reported as settled without a receipt. */
export class Blocky402Facilitator implements PaymentFacilitator {
  readonly name = 'blocky402';
  readonly mode = 'live' as const;
  private feePayer?: string;
  constructor(private baseUrl: string) {}
  private async post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000), body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }
  async prepare(requirements: PaymentRequirements): Promise<PaymentRequirements> {
    if (!this.feePayer) {
      const response = await fetch(new URL('/supported', this.baseUrl), { signal: AbortSignal.timeout(15_000) });
      const parsed = z.object({
        kinds: z.array(z.object({ network: z.string(), scheme: z.string(), x402Version: z.number(), extra: z.record(z.string(), z.unknown()).optional() })),
        signers: z.record(z.string(), z.array(z.string())).optional(),
      }).safeParse(await response.json().catch(() => null));
      if (!response.ok || !parsed.success) throw new Error('facilitator_supported_unavailable');
      const kind = parsed.data.kinds.find(item => item.x402Version === 2 && item.scheme === 'exact' && item.network === requirements.network);
      const advertised = kind?.extra?.feePayer ?? parsed.data.signers?.['hedera:*']?.[0];
      if (typeof advertised !== 'string' || !/^\d+\.\d+\.\d+$/.test(advertised)) throw new Error('facilitator_hedera_fee_payer_missing');
      this.feePayer = advertised;
    }
    return { ...requirements, extra: { ...requirements.extra, feePayer: this.feePayer } };
  }
  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResult> {
    let result;
    try { result = await this.post('/verify', { x402Version: 2, paymentPayload, paymentRequirements }); }
    catch { return { valid: false, reason: 'facilitator_unreachable' }; }
    const body = z.object({ isValid: z.boolean(), payer: z.string().max(128).optional(), invalidReason: z.string().max(256).optional(), invalidMessage: z.string().max(512).optional() })
      .safeParse(result.json);
    if (result.status !== 200 || !body.success) return { valid: false, reason: 'facilitator_verify_failed' };
    return { valid: body.data.isValid, payer: body.data.payer, reason: body.data.invalidReason ?? body.data.invalidMessage };
  }
  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResult> {
    let result;
    // A transport failure leaves settlement unknown: the caller must reconcile, not re-charge.
    try { result = await this.post('/settle', { x402Version: 2, paymentPayload, paymentRequirements }); }
    catch { throw new SettlementAmbiguousError('The facilitator did not return a settlement result.'); }
    const body = settleSchema.safeParse(result.json);
    if (!body.success) {
      const reason = facilitatorError(result.json, `facilitator_http_${result.status}`);
      if (result.status >= 500 || result.status < 400) throw new SettlementAmbiguousError(reason);
      throw new PaymentRejectedError(reason);
    }
    if (!body.data.success) {
      // A returned transaction reference means the facilitator may have broadcast before reporting
      // failure. Preserve it for reconciliation and never issue another charge automatically.
      if (body.data.transaction) throw new SettlementAmbiguousError(`transaction:${body.data.transaction}`);
      throw new PaymentRejectedError(body.data.errorReason ?? body.data.errorMessage ?? 'facilitator_declined_settlement');
    }
    if (!body.data.transaction) throw new SettlementAmbiguousError('facilitator_success_without_transaction');
    return { transaction: body.data.transaction, payer: body.data.payer, network: body.data.network ?? paymentRequirements.network, mode: this.mode };
  }
}

/**
 * Local development settlement. It performs no Hedera transaction and every record it produces is
 * stored and displayed as `simulated`, so it can never be mistaken for a settled testnet payment.
 */
export class SimulatedFacilitator implements PaymentFacilitator {
  readonly name = 'simulated';
  readonly mode = 'simulated' as const;
  async prepare(requirements: PaymentRequirements): Promise<PaymentRequirements> {
    return { ...requirements, extra: { ...requirements.extra, feePayer: '0.0.0' } };
  }
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult> {
    if (payload.accepted.network !== requirements.network) return { valid: false, reason: 'network_mismatch' };
    const payer = typeof payload.payload.payer === 'string' ? payload.payload.payer : undefined;
    if (!payer) return { valid: false, reason: 'missing_payer' };
    return { valid: true, payer };
  }
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult> {
    const digest = createHash('sha256').update(JSON.stringify([requirements.extra.nonce, payload.payload])).digest('hex').slice(0, 32);
    return { transaction: `simulated:${digest}`, payer: String(payload.payload.payer), network: requirements.network, mode: this.mode };
  }
}

export function paymentMatches(payload: PaymentPayload, requirements: PaymentRequirements): boolean {
  const accepted = payload.accepted;
  return accepted.scheme === requirements.scheme && accepted.network === requirements.network
    && accepted.asset === requirements.asset && accepted.amount === requirements.amount
    && accepted.payTo === requirements.payTo && accepted.maxTimeoutSeconds === requirements.maxTimeoutSeconds
    && accepted.extra.nonce === requirements.extra.nonce && accepted.extra.feePayer === requirements.extra.feePayer;
}

export function createFacilitator(config: PaymentsConfig): PaymentFacilitator {
  return config.mode === 'simulated' ? new SimulatedFacilitator() : new Blocky402Facilitator(config.facilitatorUrl);
}
