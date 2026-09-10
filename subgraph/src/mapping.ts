import { Address, BigInt, Bytes, DataSourceContext, dataSource } from '@graphprotocol/graph-ts';
import { Market, Strategy, Fill, Route } from '../generated/schema';
import { MarketCreated } from '../generated/Registry/MarketRegistry';
import { Shipped, Docked } from '../generated/Aqua/Aqua';
import { HorizonSwapVM, CurveFilled, StrategyAdmitted } from '../generated/Router/HorizonSwapVM';
import { RouteExecuted } from '../generated/Executor/RouteExecutor';
import { CollateralChanged, MarketResolved } from '../generated/templates/BinaryMarket/BinaryMarket';
import { BinaryMarket } from '../generated/templates';

export function handleMarket(event: MarketCreated): void {
  let m = new Market(event.params.market);
  m.creationId = event.params.creationId; m.question = event.params.question; m.rules = event.params.rules;
  m.evidenceSource = event.params.evidenceSource; m.closeAt = event.params.closeAt; m.resolver = event.params.resolver;
  m.yesToken = event.params.yesToken; m.noToken = event.params.noToken; m.result = 0; m.resolutionEvidence = '';
  m.collateral = BigInt.zero(); m.createdAt = event.block.timestamp; m.save();
  BinaryMarket.create(event.params.market);
}
export function handleShip(event: Shipped): void {
  let configured = Address.fromString(dataSource.context().getString('router'));
  if (!event.params.app.equals(configured)) return;
  let parsed = HorizonSwapVM.bind(configured).try_decodeCurveOrder(event.params.strategy);
  if (parsed.reverted) return;
  let curve = parsed.value.value0;
  if (!parsed.value.value1.equals(event.params.maker) || !parsed.value.value2.equals(event.params.strategyHash)) return;
  if (Market.load(curve.market) == null) return;
  let s = new Strategy(event.params.strategyHash);
  s.market = curve.market; s.maker = event.params.maker; s.flags = curve.flags;
  s.startPrice = curve.startPrice; s.endPrice = curve.endPrice; s.maxShares = curve.maxShares; s.salt = curve.salt;
  s.filled = BigInt.zero(); s.active = true; s.admitted = false; s.publishedAt = event.block.timestamp; s.save();
}
/** Aqua publication alone is not executable liquidity; the router's admission is what makes it so. */
export function handleAdmit(event: StrategyAdmitted): void {
  let s = Strategy.load(event.params.orderHash); if (s == null) return;
  s.admitted = true; s.admittedAt = event.block.timestamp; s.save();
}
export function handleFill(event: CurveFilled): void {
  let s = Strategy.load(event.params.orderHash); if (s == null) return;
  s.filled = event.params.totalFilled;
  if (s.filled.ge(s.maxShares)) s.active = false;
  s.save();
  let f = new Fill(event.transaction.hash.concatI32(event.logIndex.toI32()));
  f.strategy = s.id; f.shares = event.params.shares; f.usdc = event.params.usdcAmount;
  f.block = event.block.number; f.transaction = event.transaction.hash; f.save();
}
export function handleCollateral(event: CollateralChanged): void {
  let m = Market.load(event.address); if (m == null) return; m.collateral = event.params.collateral; m.save();
}
export function handleResolution(event: MarketResolved): void {
  let m = Market.load(event.address); if (m == null) return;
  m.result = event.params.result; m.resolutionEvidence = event.params.evidence; m.save();
}
export function handleRoute(event: RouteExecuted): void {
  let r = new Route(event.transaction.hash.concatI32(event.logIndex.toI32()));
  r.market = event.params.market; r.taker = event.params.taker; r.recipient = event.params.recipient;
  r.isYes = event.params.isYes; r.isBuy = event.params.isBuy; r.shares = event.params.shares;
  r.usdc = event.params.usdcAmount; r.fills = event.params.fills; r.transaction = event.transaction.hash;
  r.block = event.block.number; r.save();
}
