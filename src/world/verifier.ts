import { z } from 'zod';
import type { WorldConfig } from '../config.js';

/** Zero-knowledge proof material submitted by the client. None of it is persisted. */
export const proofSchema = z.object({
  nullifierHash: z.string().regex(/^0x[0-9a-fA-F]{16,128}$/),
  merkleRoot: z.string().regex(/^0x[0-9a-fA-F]{16,128}$/),
  proof: z.string().min(16).max(8192),
  verificationLevel: z.enum(['orb', 'device', 'document', 'secure_document', 'selfie']),
  signal: z.string().max(256).optional(),
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
  verify(proof: VerificationProof): Promise<VerificationResult>;
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
  async verify(proof: VerificationProof): Promise<VerificationResult> {
    const url = new URL(`/api/v2/verify/${encodeURIComponent(this.config.appId)}`, this.config.verifyUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          nullifier_hash: proof.nullifierHash, merkle_root: proof.merkleRoot, proof: proof.proof,
          verification_level: proof.verificationLevel, action: this.config.action,
          ...(proof.signal ? { signal: proof.signal } : {}),
        }),
      });
    } catch { throw new VerificationUnavailableError('World verification endpoint was unreachable.'); }
    if (response.status === 200) {
      const body = z.object({ success: z.boolean(), verification_level: z.string().optional() })
        .safeParse(await response.json().catch(() => null));
      if (!body.success || !body.data.success) throw new VerificationRejectedError('World did not confirm the credential.');
      return { nullifierHash: proof.nullifierHash, credentialType: body.data.verification_level ?? proof.verificationLevel, verifier: this.name };
    }
    if (response.status === 400 || response.status === 403) throw new VerificationRejectedError('World rejected the submitted proof.');
    throw new VerificationUnavailableError(`World verification service returned HTTP ${response.status}.`);
  }
}

export function createVerifier(config: WorldConfig): HumanVerifier {
  if (config.access !== 'granted') {
    return new UnavailableVerifier(`World Selfie Check access is declared "${config.access}". No credential can be verified, so the human discount is not applied.`);
  }
  if (!config.appId || !config.action) return new UnavailableVerifier('WORLD_APP_ID and WORLD_ACTION must be configured before verification can run.');
  return new WorldSelfieVerifier(config);
}
