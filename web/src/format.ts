/** All protocol amounts are integers in base units; never parse them as floating point. */
export const USDC_DECIMALS = 6;

export function formatUnits(value: bigint | string, decimals: number, maxFraction = decimals): string {
  const units = typeof value === 'string' ? BigInt(value) : value;
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).slice(0, maxFraction).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function parseUnits(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) throw new Error('Enter a positive number.');
  const [whole = '0', fraction = ''] = value.trim().split('.');
  if (fraction.length > decimals) throw new Error(`At most ${decimals} decimal places are supported.`);
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

export const usdc = (value: bigint | string) => `${formatUnits(value, USDC_DECIMALS)} USDC`;
export const shares = (value: bigint | string) => formatUnits(value, USDC_DECIMALS);

/** Outcome prices are micro-USDC per whole share; show them as probabilities. */
export const price = (micro: number | null) => micro === null ? '—' : `${(micro / 10_000).toFixed(2)}¢`.replace('¢', '%');
export const priceUsdc = (micro: number | null) => micro === null ? '—' : `${(micro / 1_000_000).toFixed(4)} USDC`;

export function timeLeft(closeAt: number): string {
  const seconds = closeAt - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return 'closed';
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h left`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

export const dateTime = (value: number | string) =>
  new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const short = (value: string) => value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
