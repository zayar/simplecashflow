import { Prisma } from '@prisma/client';

export function toMoneyDecimal(value: number): Prisma.Decimal {
  // Use Decimal for money to avoid floating point drift.
  // We round to 2 decimals because our DB columns are Decimal(18,2).
  return new Prisma.Decimal(Number(value).toFixed(2));
}

