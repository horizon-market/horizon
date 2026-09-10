/**
 * Creation access tokens live in this browser and nowhere else: the server stores only a hash, so
 * whoever holds the token is the only one who can move that request along, and losing it strands
 * the request for good.
 *
 * The create page tracks one *active* request. This keeps every token the browser has been issued,
 * so starting a new request never throws away the key to an older one — which is what lets the
 * portfolio offer to resume a request that was left mid-flight.
 */
const ACTIVE = 'horizon.creation';
const ARCHIVE = 'horizon.creations';
const KEEP = 50;

export type Saved = { id: string; token: string };
type Archive = Record<string, string>;

const read = (): Archive => {
  try { const stored = localStorage.getItem(ARCHIVE); return stored ? JSON.parse(stored) as Archive : {}; }
  catch { return {}; }
};

const write = (archive: Archive) => {
  // Object keys keep insertion order, so trimming from the front drops the oldest tokens first.
  const entries = Object.entries(archive);
  const kept = entries.length > KEEP ? entries.slice(entries.length - KEEP) : entries;
  try { localStorage.setItem(ARCHIVE, JSON.stringify(Object.fromEntries(kept))); }
  catch { /* storage may be unavailable */ }
};

export const rememberCreation = ({ id, token }: Saved) => { const archive = read(); archive[id] = token; write(archive); };
export const forgetCreation = (id: string) => { const archive = read(); delete archive[id]; write(archive); };
export const creationToken = (id: string): string | undefined => read()[id];

/** Points the create page at an existing request, for a resume link raised somewhere else. */
export const activateCreation = (saved: Saved) => {
  rememberCreation(saved);
  try { localStorage.setItem(ACTIVE, JSON.stringify(saved)); } catch { /* storage may be unavailable */ }
};

/** Statuses a requester can still walk away from: nothing has been paid and nothing is settling. */
export const isDiscardable = (status: string, paymentStatus?: string | null) =>
  ['DRAFT', 'APPROVED', 'PAYMENT_REQUIRED'].includes(status)
  && (!paymentStatus || ['REQUIRED', 'FAILED', 'CANCELLED'].includes(paymentStatus));

/** Nothing left to do: the market exists, or the request was discarded. */
export const isFinished = (status: string) => status === 'CREATED' || status === 'ABANDONED';

export const CREATION_BADGE: Record<string, 'open' | 'closed' | 'resolved' | 'warn' | 'no'> = {
  DRAFT: 'open', APPROVED: 'open', PAYMENT_REQUIRED: 'warn', PAYMENT_REVIEW: 'warn',
  PAID: 'open', CREATING: 'open', CREATED: 'resolved', FAILED: 'no', ABANDONED: 'closed',
};

export const CREATION_LABEL: Record<string, string> = {
  DRAFT: 'Draft', APPROVED: 'Approved', PAYMENT_REQUIRED: 'Payment due', PAYMENT_REVIEW: 'Payment in review',
  PAID: 'Paid', CREATING: 'Creating', CREATED: 'Created', FAILED: 'Failed', ABANDONED: 'Discarded',
};
