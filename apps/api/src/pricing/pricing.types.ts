import type { Calculation } from './calculate';
import type { QuoteInput } from './pricing.dto';

// Raw PostgreSQL row (snake_case); API serialization is handled by the controller.
export type PricingQuoteRow = {
  id: number;
  base_quote_id: number | null;
  version: number;
  created_at: Date;
  expires_at: Date;
  confirmed_at: Date | null;
  created_by: number;
  confirmed_by: number | null;
  confirmed_overrides: string[] | null;
  input: QuoteInput;
  snapshot: Calculation;
};
