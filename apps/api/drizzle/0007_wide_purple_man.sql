ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quotes_base_quote_id_pricing_quotes_id_fk" FOREIGN KEY ("base_quote_id") REFERENCES "public"."pricing_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quote_confirmation" CHECK ((confirmed_at IS NULL AND confirmed_by IS NULL AND confirmed_overrides IS NULL AND version=1) OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_overrides IS NOT NULL AND version=2));
--> statement-breakpoint
-- Initial price catalog, not customer/vehicle demo data. Existing groups and model
-- assignments stay untouched; unconfigured legacy groups have no inferred price.
INSERT INTO pricing_groups(name,tariff_code) VALUES
 ('Nexia / Fabia / Logan','economy'),
 ('Polo / Solaris / Almera','standard'),
 ('Jetta / Octavia','comfort'),
 ('Berlingo','berlingo'),
 ('Boxer / Jumper / Sprinter / Transit','cargo')
ON CONFLICT DO NOTHING;
