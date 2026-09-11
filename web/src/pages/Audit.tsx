import { useState } from 'react';
import { useConfig } from '../App';
import { useAsync } from '../hooks';
import { Badge, Card, Notice } from '../components/Ui';
import { AUDIT_LABEL } from '../components/AuditTrail';
import { dateTime, short } from '../format';

/**
 * The audit trail explained the way the curve page explains curves: by letting the reader do the
 * thing themselves. The centrepiece reads the topic straight from a Hedera mirror node, in the
 * browser, and rederives each statement's id — the one check that needs nothing from Horizon.
 */

/** One message as the mirror node serves it, with the statement decoded from it when it parses. */
type Statement = {
  sequence: number;
  consensusAt: string;
  payer: string;
  raw: string;
  message?: {
    schema: string; type: string; eventId: string; requestId: string; occurredAt: string; draftHash: string; backfilled?: true;
    payment?: { network?: string; asset?: string; amountUnits?: string; transactionRef: string };
    market?: { chainId: number; address: string; transactionHash: string | null; position?: number };
  };
  /** Whether sha256 over the schema, request, type and position reproduces the id the message carries. */
  derived?: boolean;
};

const AUDIT_SCHEMA = 'horizon.audit.v1';

/** `eventId` as the service derives it, recomputed here so the recipe is demonstrated, not asserted. */
async function deriveEventId(requestId: string, type: string, position?: number): Promise<string> {
  const key = position === undefined ? `${AUDIT_SCHEMA}:${requestId}:${type}` : `${AUDIT_SCHEMA}:${requestId}:${type}:${position}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A consensus timestamp is `seconds.nanos`; the nearest millisecond is what a person reads. */
const consensusTime = (timestamp: string) => {
  const [seconds, nanos = '0'] = timestamp.split('.');
  return dateTime(Number(seconds) + Number(nanos.padEnd(9, '0')) / 1e9);
};

/** The latest messages on the topic, from the mirror node the deployment names, never from Horizon. */
async function readTopic(mirrorNodeUrl: string, topicId: string, limit = 12): Promise<Statement[]> {
  const response = await fetch(new URL(`/api/v1/topics/${topicId}/messages?order=desc&limit=${limit}`, mirrorNodeUrl));
  if (!response.ok) throw new Error(`mirror_http_${response.status}`);
  const body = await response.json() as { messages: { consensus_timestamp: string; message: string; payer_account_id: string; sequence_number: number }[] };
  return Promise.all(body.messages.map(async entry => {
    const raw = new TextDecoder().decode(Uint8Array.from(atob(entry.message), char => char.charCodeAt(0)));
    const statement: Statement = { sequence: entry.sequence_number, consensusAt: entry.consensus_timestamp, payer: entry.payer_account_id, raw };
    try {
      const message = JSON.parse(raw) as Statement['message'];
      if (message?.schema === AUDIT_SCHEMA && typeof message.eventId === 'string') {
        statement.message = message;
        statement.derived = await deriveEventId(message.requestId, message.type, message.market?.position) === message.eventId;
      }
    } catch { /* Not one of Horizon's statements; shown as bytes, not hidden. */ }
    return statement;
  }));
}

export function Audit() {
  const config = useConfig();
  const audit = config.audit;
  return (
    <div className="stack">
      <h1>How the audit trail works</h1>
      <p>
        Every market created on Horizon leaves three statements on a public Hedera Consensus Service topic: that a
        draft was approved, that the creation fee settled, and that each market was deployed — in that order, each
        with a consensus timestamp that Horizon cannot set. Anyone can read them back from a Hedera mirror node
        without asking Horizon, and this page does exactly that.
      </p>
      <p className="muted">
        The point is the order and the time. Horizon can say what it likes about its own process, but it cannot
        later claim it approved a draft before it was paid, or deployed a market it never paid for, without the
        topic showing otherwise.
      </p>

      <h2>Three statements per request</h2>
      <p className="small muted">
        Each is written to Horizon&rsquo;s database in the same transaction as the step it records, then published by
        a worker within seconds. A step that cannot be recorded does not happen; a topic that cannot be reached
        delays the trail and changes nothing about the payment or the deployment.
      </p>
      <div className="grid">
        <Card title={<>1 &middot; Draft approved</>}>
          <p className="small" style={{ marginTop: 0 }}>The requester approved the exact draft they reviewed.</p>
          <dl className="kv">
            <dt>Carries</dt><dd>the request id and the <span className="mono">draftHash</span> that was approved</dd>
            <dt>Pins</dt><dd>what was agreed, before any money moved</dd>
          </dl>
        </Card>
        <Card title={<>2 &middot; Payment settled</>}>
          <p className="small" style={{ marginTop: 0 }}>The x402 charge for that draft settled on Hedera.</p>
          <dl className="kv">
            <dt>Carries</dt><dd>network, asset, amount and the Hedera transaction reference</dd>
            <dt>Pins</dt><dd>the same <span className="mono">draftHash</span>, so the fee and the draft cannot drift apart</dd>
          </dl>
        </Card>
        <Card title={<>3 &middot; Market created</>}>
          <p className="small" style={{ marginTop: 0 }}>A market was deployed on Sepolia — one statement per market in a group.</p>
          <dl className="kv">
            <dt>Carries</dt><dd>the market address, its deployment transaction and the payment reference it was funded by</dd>
            <dt>Pins</dt><dd>which on-chain market that draft and that payment became</dd>
          </dl>
        </Card>
      </div>

      <h2>What it attests &mdash; and what it does not</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Card title="It shows">
          <ul className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li>that Horizon made each statement, and in which order</li>
            <li>when each reached consensus, on a clock Horizon does not control</li>
            <li>the references — draft hash, payment transaction, market address — that let you check each step at its own source</li>
            <li>that only Horizon can append: the topic&rsquo;s submit key is the audit signer&rsquo;s public key</li>
          </ul>
        </Card>
        <Card title="It does not show">
          <ul className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li>that the payment is real &mdash; check the transaction reference on Hedera</li>
            <li>that the market exists &mdash; check the address on Sepolia</li>
            <li>how a market resolved, or any trade in it &mdash; those are on chain, not on the topic</li>
            <li>who the requester is: no name, no wallet, no token, no proof is ever published</li>
          </ul>
        </Card>
      </div>

      <h2>Read one yourself</h2>
      {audit.available && audit.topicId
        ? <LiveTopic topicId={audit.topicId} topicUrl={audit.topicUrl} mirrorNodeUrl={audit.mirrorNodeUrl} network={audit.network} />
        : <Notice kind="info">No topic is configured on this deployment, so there is nothing to read yet. Statements are still recorded and can be published later.</Notice>}

      <h2>Things to know</h2>
      <dl className="kv">
        <dt>Delivery</dt>
        <dd>At least once. Hedera orders and timestamps messages; it does not deduplicate them. A submission whose outcome was unknown is looked up on the mirror node first and only resent if it cannot be found, so one statement can appear twice. Readers deduplicate by <span className="mono">eventId</span>.</dd>
        <dt>Unconfirmed</dt>
        <dd>A statement was submitted and its outcome is unknown. It is never shown as published and never given a consensus timestamp until the mirror node confirms it.</dd>
        <dt>Backfilled</dt>
        <dd>A statement written after the fact for a request that predates the trail carries <span className="mono">"backfilled": true</span>. Its consensus timestamp is when Horizon published it, not when the event happened; the event time travels in <span className="mono">occurredAt</span>.</dd>
        <dt>Event id</dt>
        <dd><span className="mono">sha256("{AUDIT_SCHEMA}:" + requestId + ":" + type [+ ":" + position])</span> — derived, not assigned, so two attempts at one statement can never disagree about its id. The table above recomputes it in your browser.</dd>
      </dl>

      <Card title="See it on a market">
        <p style={{ marginTop: 0 }}>
          Every event and market page carries its own trail, with a button that reads each statement back from the
          mirror node and compares it byte for byte with what Horizon holds.
        </p>
        <a className="button primary" href="/">Browse markets</a>
      </Card>
    </div>
  );
}

/**
 * The topic as the mirror node serves it right now. Read by the browser, so the request never
 * passes through Horizon and the answer is the same one anyone gets from the same URL.
 */
function LiveTopic({ topicId, topicUrl, mirrorNodeUrl, network }: { topicId: string; topicUrl: string | null; mirrorNodeUrl: string; network: string }) {
  const topic = useAsync(() => readTopic(mirrorNodeUrl, topicId), [mirrorNodeUrl, topicId]);
  const [open, setOpen] = useState<number | undefined>();
  const listUrl = `${mirrorNodeUrl.replace(/\/$/, '')}/api/v1/topics/${topicId}/messages?order=desc&limit=12`;
  return (
    <Card
      title={<>Latest statements on topic <span className="mono">{topicId}</span></>}
      actions={<span className="row">
        {topicUrl && <a className="small" href={topicUrl} target="_blank" rel="noreferrer">HashScan</a>}
        <button disabled={topic.loading} onClick={topic.reload}>{topic.loading ? 'Reading…' : 'Read again'}</button>
      </span>}
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        Fetched by <strong>your browser</strong> from <a className="mono" href={listUrl} target="_blank" rel="noreferrer">{new URL(mirrorNodeUrl).host}</a> on
        Hedera {network}, not from Horizon. Each row&rsquo;s id is recomputed here from the recipe below; open a row to see the bytes.
      </p>
      {topic.loading && <p className="small muted">Reading the topic…</p>}
      {topic.error !== undefined && (
        <Notice kind="warn">
          The mirror node could not be read from your browser just now — the public mirror nodes rate-limit by IP address.
          Try again in a moment, or open the topic on{' '}
          {topicUrl ? <a href={topicUrl} target="_blank" rel="noreferrer">HashScan</a> : 'HashScan'}.
        </Notice>
      )}
      {topic.data && topic.data.length === 0 && <p className="small muted">The topic exists and has no messages yet.</p>}
      {topic.data && topic.data.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th>#</th><th>Statement</th><th>Request</th><th>Market</th><th>Consensus</th><th>Id</th><th /></tr></thead>
            <tbody>
              {topic.data.map(statement => {
                const message = statement.message;
                const expanded = open === statement.sequence;
                return [
                  <tr key={statement.sequence}>
                    <td className="mono">
                      <a href={`${mirrorNodeUrl.replace(/\/$/, '')}/api/v1/topics/${topicId}/messages/${statement.sequence}`} target="_blank" rel="noreferrer">#{statement.sequence}</a>
                    </td>
                    <td>
                      {message ? (AUDIT_LABEL[message.type] ?? message.type) : <span className="muted">Not a Horizon statement</span>}
                      {message?.backfilled && <> <Badge kind="warn">backfilled</Badge></>}
                    </td>
                    <td className="mono small">{message ? short(message.requestId) : '—'}</td>
                    <td className="mono small">
                      {message?.market
                        ? <a href={`/markets/${message.market.address.toLowerCase()}`}>{short(message.market.address)}</a>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="small">
                      <a href={`https://hashscan.io/${network}/transaction/${statement.consensusAt}`} target="_blank" rel="noreferrer">{consensusTime(statement.consensusAt)}</a>
                    </td>
                    <td>
                      {message
                        ? statement.derived
                          ? <Badge kind="resolved">matches recipe</Badge>
                          : <Badge kind="no">does not match</Badge>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="right"><button className="link" onClick={() => setOpen(expanded ? undefined : statement.sequence)}>{expanded ? 'Hide' : 'Bytes'}</button></td>
                  </tr>,
                  expanded && (
                    <tr key={`${statement.sequence}-raw`}>
                      <td colSpan={7}>
                        <pre className="small scroll" style={{ margin: 0 }}><code>{prettify(statement.raw)}</code></pre>
                        <p className="small muted" style={{ marginBottom: 0 }}>
                          Paid for by Hedera account <span className="mono">{statement.payer}</span> &middot; exactly the bytes the mirror node returned, base64-decoded.
                        </p>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const prettify = (raw: string) => { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; } };
