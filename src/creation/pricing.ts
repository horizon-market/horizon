/**
 * Creation-service pricing. This charge is separate from trading, which has no maker,
 * taker, routing or protocol fee. The discount applies only to a server-verified credential.
 */
export type PriceBreakdown = { baseUnits: bigint; discountBps: number; discountUnits: bigint; payableUnits: bigint };

export function creationPrice(baseUnits: bigint, discountBps: number, eligible: boolean): PriceBreakdown {
  if (baseUnits <= 0n) throw new Error('invalid_base_price');
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) throw new Error('invalid_discount_bps');
  const applied = eligible ? discountBps : 0;
  // Round the discount down so the payable amount is never below the intended net price.
  const discountUnits = (baseUnits * BigInt(applied)) / 10_000n;
  return { baseUnits, discountBps: applied, discountUnits, payableUnits: baseUnits - discountUnits };
}

/**
 * A group is priced per child, at the same per-market price a standalone creation pays: creating
 * three markets inside one event costs what creating three markets costs. The discount is applied
 * once, to the group total, on the same terms — a verified credential is worth one discounted
 * creation request per UTC day, not one per child.
 */
export type GroupPriceBreakdown = PriceBreakdown & { unitUnits: bigint; quantity: number };

export function groupPrice(unitUnits: bigint, quantity: number, discountBps: number, eligible: boolean): GroupPriceBreakdown {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 24) throw new Error('invalid_quantity');
  const breakdown = creationPrice(unitUnits * BigInt(quantity), discountBps, eligible);
  return { ...breakdown, unitUnits, quantity };
}

/** Discount entitlement is bounded to one creation per credential per UTC day. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function formatUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals).replace(/0+$/, '')}`;
  return `${negative ? '-' : ''}${whole}${fraction === '.' ? '' : fraction}`;
}
