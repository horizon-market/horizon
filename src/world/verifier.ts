import { z } from 'zod';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { signRequest } from '@worldcoin/idkit-core/signing';
import type { WorldConfig } from '../config.js';

/** Complete IDKit result. World requires forwarding this object without field remapping. */
export const proofSchema = z.object({
  protocol_version: z.literal('3.0'),
  nonce: z.string().min(1).max(128),
  action: z.string().min(1).max(128),
  environment: z.enum(['staging', 'production']),
  responses: z.array(z.object({
    identifier: z.string().min(1).max(64), signal_hash: z.string().regex(/^0x[0-9a-fA-F]{1,128}$/),
    proof: z.string().min(16).max(16384), merkle_root: z.string().regex(/^0x[0-9a-fA-F]{1,128}$/),
    nullifier: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  }).strict()).min(1).max(8),
  user_presence_completed: z.boolean(),
}).strict();
export type VerificationProof = z.infer<typeof proofSchema>;

/** Only the minimum needed to bind a discount and prevent replay is returned for storage. */
export type VerificationResult = { nullifierHash: string; credentialType: string; verifier: string };

export class VerificationUnavailableError extends Error {
  constructor(readonly reason: string) { super('verification_unavailable'); }
}
export class VerificationRejectedError extends Error {
  constructor(readonly reason: string) { super('verification_rejected'); }
}

export interface HumanVerifier {
  readonly name: string;
  readonly available: boolean;
  readonly reason: string;
  verify(proof: VerificationProof, signal: string): Promise<VerificationResult>;
}

/** Declared-but-unavailable access is an explicit state, never a silently successful verification. */
export class UnavailableVerifier implements HumanVerifier {
  readonly name = 'world-selfie-check';
  readonly available = false;
  constructor(readonly reason: string) {}
  async verify(): Promise<VerificationResult> { throw new VerificationUnavailableError(this.reason); }
}

/** Server-side proof verification against World's cloud endpoint. The browser never decides eligibility. */
export class WorldSelfieVerifier implements HumanVerifier {
  readonly name = 'world-selfie-check';
  readonly available = true;
  readonly reason = 'World Selfie Check access is declared granted; proofs are verified server-side.';
  constructor(private config: WorldConfig) {}
  async verify(proof: VerificationProof, signal: string): Promise<VerificationResult> {
    if (proof.action !== this.config.action || proof.environment !== this.config.environment) {
      throw new VerificationRejectedError('World proof context does not match this deployment.');
    }
    const expectedSignal = hashSignal(signal).toLowerCase();
    if (proof.responses.some(item => item.signal_hash.toLowerCase() !== expectedSignal)) {
      throw new VerificationRejectedError('World proof is not bound to this creation request.');
    }
    const url = new URL(`/api/v4/verify/${encodeURIComponent(this.config.rpId)}`, this.config.verifyUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(proof),
      });
    } catch { throw new VerificationUnavailableError('World verification endpoint was unreachable.'); }
    if (response.status === 200) {
      const body = z.object({ success: z.boolean().optional() }).passthrough()
        .safeParse(await response.json().catch(() => null));
      if (!body.success || body.data.success === false) throw new VerificationRejectedError('World did not confirm the credential.');
      const nullifiers = new Set(proof.responses.map(item => item.nullifier.toLowerCase()));
      if (nullifiers.size !== 1) throw new VerificationRejectedError('World returned inconsistent credential nullifiers.');
      return {
        nullifierHash: [...nullifiers][0]!,
        credentialType: proof.responses.map(item => item.identifier).sort().join('+'),
        verifier: this.name,
      };
    }
    if (response.status === 400 || response.status === 403) throw new VerificationRejectedError('World rejected the submitted proof.');
    throw new VerificationUnavailableError(`World verification service returned HTTP ${response.status}.`);
  }
}

export function createRpContext(config: WorldConfig) {
  if (config.access !== 'granted' || !config.rpId || !config.signingKey || !config.action) {
    throw new VerificationUnavailableError('World RP request signing is not configured.');
  }
  const signed = signRequest({ signingKeyHex: config.signingKey, action: config.action, ttl: 300 });
  return { rp_id: config.rpId, nonce: signed.nonce, created_at: signed.createdAt, expires_at: signed.expiresAt, signature: signed.sig };
}

export function createVerifier(config: WorldConfig): HumanVerifier {
  if (config.access !== 'granted') {
    return new UnavailableVerifier(`World Selfie Check access is declared "${config.access}". No credential can be verified, so the human discount is not applied.`);
  }
  if (!config.appId || !config.rpId || !config.action) return new UnavailableVerifier('WORLD_APP_ID, WORLD_RP_ID and WORLD_ACTION must be configured before verification can run.');
  return new WorldSelfieVerifier(config);
}
