import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { ExactHederaScheme, PrivateKey, createClientHederaSigner } from '@x402/hedera';
import type { PaymentRequirements as CorePaymentRequirements, PaymentPayload } from '@x402/core/types';
import type { PaymentRequirements, PaymentResource } from '../src/payments/x402.js';

type Draft = {
  question: string; yesOutcome: string; noOutcome: string; category: string; closeAt: string;
  rules: string; evidenceSource: string;
};
type CreationRequest = {
  id: string; status: string; draftHash?: string; draft?: Draft; marketAddress?: string;
  creationTxHash?: string; payment?: { transactionRef?: string };
};
type Created = { request: CreationRequest; accessToken?: string };
type Required = { x402Version: 2; resource: PaymentResource; accepts: PaymentRequirements[]; request: CreationRequest };

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const question = arg('--question');
const closeAt = arg('--close-at');
const category = arg('--category');
const approve = process.argv.includes('--approve');
const resume = process.argv.includes('--resume');
const apiBase = (process.env.HORIZON_API_URL || `http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || '3001'}`).replace(/\/$/, '');
const accountId = process.env.HEDERA_AGENT_ACCOUNT_ID;
const privateKey = process.env.HEDERA_AGENT_PRIVATE_KEY;

if (!resume && (!question || question.trim().length < 15)) {
  throw new Error('Usage: npm run agent:create -- --question "Will …?"; then npm run agent:create -- --resume --approve');
}
if (!accountId || !privateKey) throw new Error('HEDERA_AGENT_ACCOUNT_ID and HEDERA_AGENT_PRIVATE_KEY are required.');

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok && response.status !== 402) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

const stateFile = new URL('../.local/agent-creation.json', import.meta.url);
let created: Created;
if (resume) {
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as { id: string; accessToken: string };
  const current = await json<{ request: CreationRequest }>(await fetch(`${apiBase}/api/creation/requests/${state.id}`, {
    headers: { authorization: `Bearer ${state.accessToken}` },
  }));
  created = { request: current.request, accessToken: state.accessToken };
} else {
  created = await json<Created>(await fetch(`${apiBase}/api/creation/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      question: question!.trim(), requesterKind: 'agent', requester: `agent:${accountId}`,
      ...(closeAt ? { closeAt: new Date(closeAt).toISOString() } : {}), ...(category ? { category } : {}),
    }),
  }));
  if (created.accessToken) {
    await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ id: created.request.id, accessToken: created.accessToken }), { mode: 0o600 });
  }
}
if (!created.accessToken || !created.request.draftHash || !created.request.draft) throw new Error('The API did not return a new reviewable draft.');

console.log(JSON.stringify({
  requestId: created.request.id,
  draft: created.request.draft,
  notice: approve ? 'The --approve flag authorizes this exact displayed draft.' : 'Review this exact draft, then run: npm run agent:create -- --resume --approve',
}, null, 2));
if (!approve) process.exit(2);

const authorization = { authorization: `Bearer ${created.accessToken}`, 'content-type': 'application/json' };
let current = created.request;
if (current.status === 'DRAFT') {
  const approved = await json<{ request: CreationRequest }>(await fetch(`${apiBase}/api/creation/requests/${current.id}/approval`, {
    method: 'POST', headers: authorization, body: JSON.stringify({ draftHash: current.draftHash }),
  }));
  current = approved.request;
}

if (['APPROVED', 'PAYMENT_REQUIRED'].includes(current.status)) {
  const paymentResponse = await fetch(`${apiBase}/api/creation/requests/${current.id}/payment`, {
    method: 'POST', headers: authorization, body: '{}',
  });
  const required = await json<Required>(paymentResponse);
  if (paymentResponse.status !== 402 || required.x402Version !== 2 || !required.resource || required.accepts.length !== 1) {
    throw new Error('The API did not return one x402 v2 payment requirement.');
  }
  const requirements = required.accepts[0]!;
  if (requirements.network !== 'hedera:testnet' || requirements.asset !== '0.0.0' || !requirements.extra.feePayer) {
    throw new Error('The API returned unsupported Hedera payment requirements.');
  }

  // The configured hackathon agent account is ECDSA. The SDK's legacy fromString()
  // treats an untagged 32-byte value as ED25519, which produces a transaction that
  // passes local shape checks but receives INVALID_SIGNATURE from Hedera consensus.
  const key = PrivateKey.fromStringECDSA(privateKey);
  const signer = createClientHederaSigner(accountId, key, { network: requirements.network });
  const scheme = new ExactHederaScheme(signer);
  const partial = await scheme.createPaymentPayload(2, requirements as CorePaymentRequirements);
  const payload: PaymentPayload = { ...partial, resource: required.resource, accepted: requirements as CorePaymentRequirements };
  const signature = Buffer.from(JSON.stringify(payload)).toString('base64');
  const paid = await json<{ request: CreationRequest }>(await fetch(`${apiBase}/api/creation/requests/${current.id}/payment`, {
    method: 'POST', headers: { ...authorization, 'payment-signature': signature }, body: '{}',
  }));
  current = paid.request;

  const tx = current.payment?.transactionRef;
  const hashscan = tx && /^\d+\.\d+\.\d+@\d+\.\d+$/.test(tx)
    ? `https://hashscan.io/testnet/transaction/${tx.replace('@', '-').replace(/(\d+)\.(\d+)$/, '$1-$2')}`
    : undefined;
  console.log(JSON.stringify({ requestId: current.id, status: current.status, paymentTransaction: tx, hashscan }, null, 2));
}
if (current.status === 'PAYMENT_REVIEW') throw new Error('The payment needs operator reconciliation; another payment will not be attempted.');
for (let attempt = 0; attempt < 60 && ['PAID', 'CREATING'].includes(current.status); attempt++) {
  await new Promise(resolve => setTimeout(resolve, 2_000));
  const refreshed = await json<{ request: CreationRequest }>(await fetch(`${apiBase}/api/creation/requests/${created.request.id}`, { headers: authorization }));
  current = refreshed.request;
}
console.log(JSON.stringify({
  requestId: current.id, status: current.status, marketAddress: current.marketAddress,
  creationTxHash: current.creationTxHash,
}, null, 2));
if (current.status !== 'CREATED') process.exitCode = 1;
else await unlink(stateFile).catch(() => undefined);
