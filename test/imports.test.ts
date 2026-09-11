import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { GammaClient, ImportError, gammaEventSchema, parsePolymarketUrl, POLYMARKET_API_ORIGIN, SUPPORTED_URL_SHAPES } from '../src/imports/polymarket.js';
import {
  HORIZON_SETTLEMENT_CLAUSE, isPlaceholderLabel, jsonArray, mapBinaryOutcomes, normalizeEvent, outcomeMappingClause,
  outcomesComplete, slugify, snapshotEvent, toInstant,
} from '../src/imports/normalize.js';
import { draftSchema } from '../src/creation/types.js';
import { groupPrice } from '../src/creation/pricing.js';
import { groupPlanHash, eventDraftSchema, type ChildPlan, type GroupPlan } from '../src/creation/types.js';

const fixture = (name: string) => gammaEventSchema.parse(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')));
const MATCH = fixture('polymarket-event-match');
const CHAMPIONSHIP = fixture('polymarket-event-championship');
const EDGE_CASES = fixture('polymarket-event-unsupported');
const CLOSED = fixture('polymarket-event-closed');
const NFL_GAME = fixture('polymarket-event-nfl-game');
// The fixtures carry fixed source dates, so every date judgement is evaluated against a fixed now.
const NOW = new Date('2026-09-01T00:00:00Z');
const bounds = { minSeconds: 3600, maxSeconds: 365 * 24 * 3600 };
const codes = (warnings: { code: string }[]) => warnings.map(warning => warning.code);

test('only Polymarket event and market pages are accepted as import addresses', () => {
  assert.deepEqual(parsePolymarketUrl('https://polymarket.com/event/ucl-bay-bog-2026-09-10'),
    { kind: 'event', slug: 'ucl-bay-bog-2026-09-10', url: 'https://polymarket.com/event/ucl-bay-bog-2026-09-10' });
  assert.deepEqual(parsePolymarketUrl('https://www.polymarket.com/event/some-event/some-market?tid=99#x'),
    { kind: 'market', slug: 'some-market', eventSlug: 'some-event', url: 'https://polymarket.com/event/some-event/some-market' });
  assert.deepEqual(parsePolymarketUrl('polymarket.com/market/lone-market'),
    { kind: 'market', slug: 'lone-market', url: 'https://polymarket.com/market/lone-market' });
  // A sports event lives behind its league: /sports/epl/<event> addresses the same event as
  // /event/<event>, which redirects to it. The league stays in the attribution link.
  assert.deepEqual(parsePolymarketUrl('https://polymarket.com/sports/epl/epl-liv-ful-2026-09-12'),
    { kind: 'event', slug: 'epl-liv-ful-2026-09-12', url: 'https://polymarket.com/sports/epl/epl-liv-ful-2026-09-12' });
  assert.deepEqual(parsePolymarketUrl('https://www.polymarket.com/sports/nba/nba-lal-bos-2026-11-01?tid=1'),
    { kind: 'event', slug: 'nba-lal-bos-2026-11-01', url: 'https://polymarket.com/sports/nba/nba-lal-bos-2026-11-01' });
  // Every accepted shape is listed for the error message, and every listed shape parses.
  for (const shape of SUPPORTED_URL_SHAPES) {
    const address = shape.replace(/<event>/g, 'some-event').replace(/<market>/g, 'some-market').replace(/<league>/g, 'epl');
    assert.doesNotThrow(() => parsePolymarketUrl(address), address);
  }

  // Nothing that could steer the backend at another host, another scheme or another path shape.
  for (const address of [
    'https://evil.example/event/x', 'https://polymarket.com.evil.example/event/x',
    'https://gamma-api.polymarket.com/events?slug=x', 'file:///etc/passwd', 'http://127.0.0.1:9/event/x',
    'https://polymarket.com/', 'https://polymarket.com/event/', 'https://polymarket.com/profile/someone',
    'https://polymarket.com/event/a/b/c', 'https://polymarket.com/event/../../admin', '', '   ',
    // A league addresses a listing page, and no other section prefix is a page Polymarket serves.
    'https://polymarket.com/sports/epl', 'https://polymarket.com/sports',
    'https://polymarket.com/sports/epl/an-event/a-market',
    'https://polymarket.com/politics/fed-decision-in-september-762',
    'https://polymarket.com/crypto/some-event',
  ]) {
    assert.throws(() => parsePolymarketUrl(address), (error: unknown) => error instanceof ImportError, address);
  }
});

test('the Gamma client fetches only its configured origin and only paths it builds itself', async () => {
  const seen: string[] = [];
  const client = new GammaClient(POLYMARKET_API_ORIGIN, async url => {
    seen.push(url);
    return Response.json(url.includes('/markets/') ? { id: '1', slug: 'child', events: [{ slug: 'ucl-bay-bog-2026-09-10' }] } : MATCH);
  });
  const resolved = await client.resolve(parsePolymarketUrl('https://polymarket.com/event/some-event/child'));
  assert.equal(resolved.focusMarketSlug, 'child');
  assert.deepEqual(seen, [
    `${POLYMARKET_API_ORIGIN}/markets/slug/child`,
    // The address named the event, so the sibling lookup uses that and not anything the reply said.
    `${POLYMARKET_API_ORIGIN}/events/slug/some-event`,
  ]);
  assert.throws(() => new GammaClient('http://gamma.example'), /POLYMARKET_API_ORIGIN/);

  const missing = new GammaClient(POLYMARKET_API_ORIGIN, async () => new Response('', { status: 404 }));
  await assert.rejects(() => missing.eventBySlug('nope'), (error: unknown) => error instanceof ImportError && error.code === 'import_source_not_found');
  const broken = new GammaClient(POLYMARKET_API_ORIGIN, async () => new Response('not json', { status: 200 }));
  await assert.rejects(() => broken.eventBySlug('nope'), (error: unknown) => error instanceof ImportError && error.code === 'import_source_unreadable');
  const down = new GammaClient(POLYMARKET_API_ORIGIN, async () => { throw new Error('offline'); });
  await assert.rejects(() => down.eventBySlug('nope'), (error: unknown) => error instanceof ImportError && error.code === 'import_source_unavailable');
});

test('Gamma\'s mixed encodings are read without inventing values', () => {
  assert.deepEqual(jsonArray('["Yes", "No"]'), ['Yes', 'No']);
  assert.deepEqual(jsonArray(['Yes', 'No']), ['Yes', 'No']);
  assert.deepEqual(jsonArray('not json'), []);
  assert.deepEqual(jsonArray(undefined), []);
  assert.equal(toInstant('2026-09-10 19:00:00+00'), '2026-09-10T19:00:00.000Z');
  assert.equal(toInstant('2026-09-10'), '2026-09-10T00:00:00.000Z');
  assert.equal(toInstant('tomorrow'), null);
  assert.equal(toInstant(''), null);
  assert.equal(slugify('FC Bayern München vs. FK Bodø/Glimt'), 'fc-bayern-munchen-vs-fk-bod-glimt');
  for (const label of ['Team H', 'team c', 'Other', 'TBD', 'Player A']) assert.equal(isPlaceholderLabel(label), true, label);
  for (const label of ['Barcelona', 'Draw', 'Real Madrid']) assert.equal(isPlaceholderLabel(label), false, label);
});

test('a three-way match imports as three independent YES/NO markets under one exclusive event', () => {
  const event = normalizeEvent(MATCH, { now: NOW, bounds });
  assert.equal(event.title, 'FC Bayern München vs. FK Bodø/Glimt');
  assert.equal(event.category, 'Sports');
  // Polymarket's negative-risk grouping is what states the rules pick exactly one winner.
  assert.equal(event.exclusivity, 'EXCLUSIVE');
  assert.match(event.exclusivityNote, /exactly one of them is meant to resolve YES/);
  assert.match(event.exclusivityNote, /shared collateral and negative-risk conversion are not implemented/);
  assert.deepEqual(codes(event.warnings), []);
  assert.deepEqual(event.children.map(child => child.outcomeLabel), [
    'FC Bayern München', 'Draw (FC Bayern München vs. FK Bodø/Glimt)', 'FK Bodø/Glimt',
  ]);
  assert.deepEqual(event.children.map(child => child.position), [0, 1, 2]);
  assert.ok(event.children.every(child => child.supported && child.preselected));

  const first = event.children[0]!;
  draftSchema.parse(first.draft);
  assert.equal(first.draft!.yesOutcome, 'YES');
  assert.equal(first.draft!.noOutcome, 'NO');
  assert.equal(first.draft!.closeAt, '2026-09-10T19:00:00.000Z');
  assert.equal(first.dates.ambiguous, false);
  // The source's criteria are kept as the standard and Horizon's own terms are appended, not
  // substituted, and the addition is reported as a change.
  assert.ok(first.draft!.rules.startsWith(first.source.description.slice(0, 60)));
  assert.ok(first.draft!.rules.endsWith(HORIZON_SETTLEMENT_CLAUSE));
  assert.ok(first.ruleChanges.some(change => /Horizon settlement terms were appended/.test(change)));
  assert.equal(first.draft!.evidenceSource, 'https://www.uefa.com/');
  assert.equal(outcomesComplete(event, new Set([0, 1, 2])), true);
  assert.equal(outcomesComplete(event, new Set([0, 2])), false);
});

test('two-outcome markets that are not labelled Yes/No import with YES and NO mapped to the source\'s sides', () => {
  const event = normalizeEvent(NFL_GAME, { now: NOW, bounds });
  assert.equal(event.title, 'Commanders vs. Eagles');
  assert.deepEqual(codes(event.warnings), []);
  assert.ok(event.children.every(child => child.supported && child.preselected));
  const by = (question: string) => event.children.find(child => child.source.slug === NFL_GAME.markets!.find(market => market.question === question)!.slug)!;

  // The recognised sports shapes become a natural question whose YES side is the first source outcome.
  const expected: [string, string, string, string][] = [
    ['Commanders vs. Eagles', 'Will the Commanders beat the Eagles?', 'Commanders vs. Eagles', 'moneyline'],
    ['Commanders vs. Eagles: 2H Moneyline', 'Will the Commanders beat the Eagles in the 2nd half?', '2H Moneyline', 'moneyline'],
    ['Spread: Eagles (-1.5)', 'Will the Eagles cover -1.5 against the Commanders?', 'Eagles (-1.5)', 'spread'],
    ['Spread: Commanders (-1.5)', 'Will the Commanders cover -1.5 against the Eagles?', 'Commanders (-1.5)', 'spread'],
    ['1Q Spread: Eagles (-0.5)', 'Will the Eagles cover -0.5 against the Commanders in the 1st quarter?', '1Q Eagles (-0.5)', 'spread'],
    ['Commanders vs. Eagles: O/U 42.5', 'Will Commanders vs. Eagles go over 42.5?', 'O/U 42.5', 'total'],
    ['Eagles Team Total: O/U 18.5', 'Will Eagles Team Total go over 18.5?', 'Eagles O/U 18.5', 'total'],
    // Anything else with two real sides states the mapping in the question itself.
    ['Commanders vs. Eagles: Team to Record Longest FG', 'Commanders vs. Eagles: Team to Record Longest FG — YES = Commanders, NO = Eagles', 'Team to Record Longest FG', 'generic'],
  ];
  for (const [source, question, label, method] of expected) {
    const child = by(source);
    assert.equal(child.question, question, source);
    assert.equal(child.outcomeLabel, label, source);
    assert.equal(child.outcomeMapping?.method, method, source);
    assert.deepEqual([child.outcomeMapping?.yes, child.outcomeMapping?.no], child.source.outcomes, source);
    // Horizon's pair is still YES/NO; the mapping is stated to the reviewer and, in the rules, to the resolver.
    assert.equal(child.draft!.yesOutcome, 'YES');
    assert.equal(child.draft!.noOutcome, 'NO');
    const [yes, no] = child.source.outcomes as [string, string];
    const clause = outcomeMappingClause(yes, no);
    assert.ok(child.draft!.rules.startsWith(child.source.description.slice(0, 60)), source);
    assert.ok(child.draft!.rules.endsWith(`${clause}\n\n${HORIZON_SETTLEMENT_CLAUSE}`), source);
    assert.match(clause, new RegExp(`resolve to "${yes}", Horizon resolves YES`));
    assert.match(clause, /50-50, void or refunded result, Horizon resolves INVALID/);
    const mapped = child.warnings.find(warning => warning.code === 'outcomes_mapped')!;
    assert.equal(mapped.severity, 'review');
    assert.match(mapped.message, new RegExp(`YES to "${yes}" and NO to "${no}"`));
    assert.ok(child.ruleChanges.some(change => change.includes(`rewritten from "${source}" to "${question}"`)), source);
  }
  // Both teams' -1.5 lines share the source label "Spread -1.5"; on Horizon each child is named for its own side.
  assert.notEqual(by('Spread: Eagles (-1.5)').outcomeLabel, by('Spread: Commanders (-1.5)').outcomeLabel);

  // Literal Yes/No markets on the same page are untouched.
  for (const source of ['Exact Margin: Commanders by 25+', 'Commanders vs. Eagles: Safety?']) {
    const child = by(source);
    assert.equal(child.question, source);
    assert.equal(child.outcomeMapping, undefined);
    assert.ok(!codes(child.warnings).includes('outcomes_mapped'));
    assert.ok(!child.draft!.rules.includes('Outcome mapping:'));
  }
  assert.equal(outcomesComplete(event, new Set(event.children.map(child => child.position))), true);
});

test('the sports rewrites only fire when the question and the source line agree; otherwise the mapping is stated generically', () => {
  const rewrite = (question: string, outcomes: [string, string], line?: number) =>
    mapBinaryOutcomes({ line } as Parameters<typeof mapBinaryOutcomes>[0], question, outcomes);
  assert.deepEqual(rewrite('Spread: Atlanta Braves (-1.5)', ['Atlanta Braves', 'San Francisco Giants'], -1.5),
    { question: 'Will the Atlanta Braves cover -1.5 against the San Francisco Giants?', outcomeLabel: 'Atlanta Braves (-1.5)', method: 'spread' });
  assert.deepEqual(rewrite('1st 5 Innings Spread: San Francisco Giants (-1.5)', ['San Francisco Giants', 'Atlanta Braves'], -1.5),
    { question: 'Will the San Francisco Giants cover -1.5 against the Atlanta Braves in the 1st 5 innings?', outcomeLabel: '1st 5 Innings San Francisco Giants (-1.5)', method: 'spread' });
  assert.deepEqual(rewrite('San Francisco Giants vs. Atlanta Braves: 1st 5 Innings O/U 2.5', ['Over', 'Under'], 2.5),
    { question: 'Will San Francisco Giants vs. Atlanta Braves: 1st 5 Innings go over 2.5?', method: 'total' });
  assert.deepEqual(rewrite('Commanders vs. Eagles: 3Q O/U 3.5', ['Over', 'Under']),
    { question: 'Will Commanders vs. Eagles go over 3.5 in the 3rd quarter?', method: 'total' });
  assert.deepEqual(rewrite('Commanders vs. Eagles: 1Q Moneyline', ['Eagles', 'Commanders']),
    { question: 'Will the Eagles beat the Commanders in the 1st quarter?', method: 'moneyline' });
  // A published line that disagrees with the question is not silently trusted either way.
  assert.equal(rewrite('Spread: Eagles (-1.5)', ['Eagles', 'Commanders'], -2.5).method, 'generic');
  assert.equal(rewrite('Commanders vs. Eagles: O/U 42.5', ['Over', 'Under'], 44.5).method, 'generic');
  // The named team must be the first outcome, and a "vs." question must name both outcomes.
  assert.equal(rewrite('Spread: Eagles (-1.5)', ['Commanders', 'Eagles']).method, 'generic');
  assert.equal(rewrite('Commanders vs. Eagles', ['Home', 'Away']).method, 'generic');
  // The generic form keeps the mapping suffix intact inside Horizon's question limit.
  const long = rewrite(`${'Very long synthetic source question '.repeat(8).trim()}?`, ['Alpha', 'Beta']);
  assert.ok(long.question.length <= 200);
  assert.ok(long.question.endsWith(' — YES = Alpha, NO = Beta'));
  assert.ok(long.question.includes('…'));
});

test('imported markets carry no source prices, liquidity, volume or settlement state', () => {
  const event = normalizeEvent(MATCH, { now: NOW, bounds });
  const serialized = JSON.stringify({ event: { ...event, snapshot: snapshotEvent(MATCH) } });
  // The fixture's own market data must not survive anywhere in what Horizon keeps or shows.
  for (const banned of ['outcomePrices', 'bestBid', 'bestAsk', 'lastTradePrice', 'liquidityNum', 'volumeNum',
    'volume24hr', 'liquidityClob', 'spread', 'clobTokenIds']) {
    assert.equal(serialized.includes(banned), false, `${banned} leaked into imported data`);
  }
  const snapshot = snapshotEvent(MATCH) as Record<string, unknown>;
  assert.equal(snapshot.title, MATCH.title);
  assert.equal(snapshot.liquidity, undefined);
  assert.equal(snapshot.volume, undefined);
  assert.match(String(snapshot.excludedFields), /not Horizon data/);
});

test('a market address imports its event but preselects only the market it named', () => {
  const event = normalizeEvent(MATCH, { now: NOW, bounds, focusMarketSlug: 'ucl-bay-bog-2026-09-10-draw' });
  assert.deepEqual(event.children.filter(child => child.preselected).map(child => child.outcomeLabel),
    ['Draw (FC Bayern München vs. FK Bodø/Glimt)']);
  assert.ok(codes(event.warnings).includes('single_market_address'));
  // A single-market selection is never an exhaustive outcome set.
  assert.equal(outcomesComplete(event, new Set([1])), false);
  const missing = normalizeEvent(MATCH, { now: NOW, bounds, focusMarketSlug: 'not-in-this-event' });
  assert.ok(codes(missing.warnings).includes('focus_market_not_in_event'));
});

test('each unsupported shape is refused for its own stated reason, and the rest still import', () => {
  const event = normalizeEvent(EDGE_CASES, { now: NOW, bounds });
  const by = (label: string) => event.children.find(child => child.outcomeLabel === label)!;

  // Not every source market is YES/NO, and the actual outcomes are named in the refusal.
  const multi = by('Winner');
  assert.equal(multi.supported, false);
  assert.ok(codes(multi.warnings).includes('unsupported_outcomes'));
  assert.match(multi.warnings.find(warning => warning.code === 'unsupported_outcomes')!.message, /Alice, Bob, Carol/);

  // Two sides that are placeholders, or that share one name, are not a market anyone can resolve.
  const unfilled = by('Bracket final');
  assert.equal(unfilled.supported, false);
  assert.match(unfilled.warnings.find(warning => warning.code === 'placeholder_outcome')!.message, /"Team A" is a placeholder/);
  assert.equal(unfilled.outcomeMapping, undefined);
  const twins = by('Same label twice');
  assert.equal(twins.supported, false);
  assert.match(twins.warnings.find(warning => warning.code === 'unsupported_outcomes')!.message, /both of this source market's outcomes are named "Over"/i);

  const settled = by('Already settled');
  assert.equal(settled.supported, false);
  assert.ok(codes(settled.warnings).includes('source_market_closed'));
  assert.ok(codes(settled.warnings).includes('source_resolution_in_progress'));

  const placeholder = by('Team C');
  assert.equal(placeholder.supported, false);
  assert.ok(codes(placeholder.warnings).includes('placeholder_outcome'));

  // Neither this market nor its event publishes an end date, so there is no time to close at.
  const undated = by('Undated');
  assert.equal(undated.supported, false);
  assert.ok(codes(undated.warnings).includes('missing_close_time'));

  // The one well-formed market still imports, and its dates need review because the source's
  // start time and end date disagree about when trading should stop.
  const supported = by('Supported outcome');
  assert.equal(supported.supported, true);
  assert.equal(supported.dates.tradingCloseAt, '2026-11-30T18:00:00.000Z');
  assert.equal(supported.dates.sourceEndDate, '2026-12-01T00:00:00.000Z');
  assert.equal(supported.dates.ambiguous, true);
  assert.ok(codes(supported.warnings).includes('date_mapping_ambiguous'));
  assert.ok(supported.ruleChanges.some(change => /earlier of the source's start time and end date/.test(change)));

  // The group is explicitly incomplete, so nothing may present it as the full outcome set.
  assert.ok(codes(event.warnings).includes('partial_outcome_set'));
  assert.equal(event.exclusivity, 'COLLECTION');
  assert.equal(outcomesComplete(event, new Set([4])), false);
});

test('a closed source event blocks the whole import, and out-of-range dates are refused with the bound named', () => {
  const closed = normalizeEvent(CLOSED, { now: NOW, bounds });
  assert.ok(codes(closed.warnings).includes('source_event_closed'));
  assert.ok(closed.warnings.some(warning => warning.severity === 'blocking'));
  assert.ok(closed.children.every(child => !child.supported && child.draft === undefined));

  // The championship fixture closes on 2027-05-30, which from early 2026 is past Horizon's
  // one-year maximum. The bound is named in the refusal rather than the date being moved.
  const far = normalizeEvent(CHAMPIONSHIP, { now: new Date('2026-04-01T00:00:00Z'), bounds });
  const barcelona = far.children.find(child => child.outcomeLabel === 'Barcelona')!;
  assert.equal(barcelona.supported, false);
  const reason = barcelona.warnings.find(warning => warning.code === 'close_time_too_far')!;
  assert.match(reason.message, /beyond Horizon's maximum of 365 days/);
  // Both the residual bucket and the unfilled slot are placeholders, not real outcomes.
  for (const label of ['Other', 'Team H']) {
    assert.ok(codes(far.children.find(child => child.outcomeLabel === label)!.warnings).includes('placeholder_outcome'), label);
  }
  assert.ok(codes(far.warnings).includes('no_supported_markets'));

  // The same event a month before it closes is importable, which is what proves the bound is the
  // only thing refusing it.
  const near = normalizeEvent(CHAMPIONSHIP, { now: new Date('2027-05-01T00:00:00Z'), bounds });
  assert.equal(near.children.find(child => child.outcomeLabel === 'Barcelona')!.supported, true);
  assert.equal(near.children.find(child => child.outcomeLabel === 'Real Madrid')!.supported, true);
  const soon = normalizeEvent(CHAMPIONSHIP, { now: new Date('2027-05-30T23:00:00Z'), bounds });
  assert.ok(codes(soon.children.find(child => child.outcomeLabel === 'Barcelona')!.warnings).includes('close_time_too_soon'));
});

test('an event with more children than the import limit reports what it left out', () => {
  const event = normalizeEvent(MATCH, { now: NOW, bounds, maxChildren: 2 });
  assert.equal(event.children.length, 2);
  const truncated = event.warnings.find(warning => warning.code === 'children_truncated')!;
  assert.match(truncated.message, /has 3 markets/);
  assert.equal(outcomesComplete(event, new Set([0, 1])), false);
});

test('a group is priced per market, and approval binds to the exact plan that was priced', () => {
  assert.equal(groupPrice(100_000_000n, 3, 5000, false).payableUnits, 300_000_000n);
  assert.equal(groupPrice(100_000_000n, 3, 5000, true).payableUnits, 150_000_000n);
  assert.equal(groupPrice(100_000_000n, 1, 5000, false).payableUnits, 100_000_000n);
  assert.throws(() => groupPrice(100_000_000n, 0, 0, false), /invalid_quantity/);
  assert.throws(() => groupPrice(100_000_000n, 25, 0, false), /invalid_quantity/);

  const normalized = normalizeEvent(MATCH, { now: NOW, bounds });
  const event = eventDraftSchema.parse({
    title: normalized.title, description: normalized.description, category: normalized.category, tags: normalized.tags,
    exclusivity: normalized.exclusivity, exclusivityNote: normalized.exclusivityNote, outcomesComplete: true,
  });
  const children: ChildPlan[] = normalized.children.map(child => ({
    position: child.position, outcomeLabel: child.outcomeLabel, draft: child.draft!, selected: true,
  }));
  const plan = (overrides: Partial<GroupPlan> = {}): GroupPlan => ({
    event, children, pricing: { baseUnits: 100_000_000n, quantity: 3, totalUnits: 300_000_000n }, ...overrides,
  });
  const hash = groupPlanHash(plan());
  assert.equal(hash, groupPlanHash(plan()));

  // Anything a reviewer looked at is inside the hash: the event, the children, the labels, the
  // order, the selection, the price and the provenance.
  const dropped = children.map((child, index) => index === 1 ? { ...child, selected: false } : child);
  assert.notEqual(hash, groupPlanHash(plan({ children: dropped })));
  assert.notEqual(hash, groupPlanHash(plan({ event: { ...event, exclusivity: 'COLLECTION' } })));
  assert.notEqual(hash, groupPlanHash(plan({ event: { ...event, title: `${event.title} (revised)` } })));
  assert.notEqual(hash, groupPlanHash(plan({ event: { ...event, outcomesComplete: false } })));
  assert.notEqual(hash, groupPlanHash(plan({ children: children.map((child, index) => index === 0 ? { ...child, outcomeLabel: 'Someone else' } : child) })));
  assert.notEqual(hash, groupPlanHash(plan({
    children: children.map((child, index) => index === 0 ? { ...child, draft: { ...child.draft, rules: `${child.draft.rules} Extra clause.` } } : child),
  })));
  assert.notEqual(hash, groupPlanHash(plan({ pricing: { baseUnits: 100_000_000n, quantity: 3, totalUnits: 200_000_000n } })));
  assert.notEqual(hash, groupPlanHash(plan({
    provenance: { provider: 'polymarket', eventId: '931729', eventSlug: 'ucl-bay-bog-2026-09-10', url: 'https://polymarket.com/event/ucl-bay-bog-2026-09-10', importedAt: NOW.toISOString() },
  })));
  // Reordering the same selection is not a change; the hash is taken in position order.
  assert.equal(hash, groupPlanHash(plan({ children: [...children].reverse() })));
});
