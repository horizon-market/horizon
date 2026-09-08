import { parseAbi } from 'viem';

export const curveTuple = '(address market,uint8 flags,uint32 startPrice,uint32 endPrice,uint64 maxShares,bytes32 salt)';
export const routerAbi = parseAbi([
  `function buildCurveOrder(address maker,${curveTuple} s) view returns ((address maker,uint256 traits,bytes data))`,
  `function curveCumulative(${curveTuple} s,uint256 q) pure returns (uint256)`,
  `function curveOutcome(${curveTuple} s) view returns (address)`,
  'function filledShares(bytes32) view returns (uint256)',
  'function registry() view returns (address)',
  'function AQUA() view returns (address)',
]);
export const routeAbi = parseAbi([
  `function execute((address market,bool isYes,bool isBuy,uint256 shares,uint256 limit,address recipient,uint40 deadline) request,(address maker,${curveTuple} strategy,uint256 shares,uint256 expectedFilled)[] legs) returns (uint256)`,
  'function router() view returns (address)',
]);
export const registryAbi = parseAbi([
  'function isMarket(address) view returns (bool)',
  'function usdc() view returns (address)',
  'function createMarket(bytes32 creationId,string question,string rules,string evidenceSource,uint40 closeAt,address resolver) returns (address)',
  'function marketByCreationId(bytes32) view returns (address)',
]);
export const marketAbi = parseAbi([
  'function isOpen() view returns (bool)', 'function yesToken() view returns (address)',
  'function noToken() view returns (address)', 'function closeAt() view returns (uint40)',
  'function mintPair(uint256 quantity,address yesRecipient,address noRecipient)',
  'function result() view returns (uint8)', 'function collateral() view returns (uint256)',
  'function resolver() view returns (address)', 'function invalidRemainder(address) view returns (uint256)',
  'function redeem(uint256 yesQuantity,uint256 noQuantity,address recipient) returns (uint256)',
  'function resolve(uint8 result,string evidence)',
]);
export const aquaAbi = parseAbi([
  'function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)',
  'function ship(address app,bytes strategy,address[] tokens,uint256[] amounts) returns (bytes32)',
  'function dock(address app,bytes32 strategyHash,address[] tokens)',
]);
