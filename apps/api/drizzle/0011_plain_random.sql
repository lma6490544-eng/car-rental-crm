ALTER TABLE "finance_allocations" ADD COLUMN "fund" text;--> statement-breakpoint
ALTER TABLE "finance_allocations" ADD CONSTRAINT "finance_allocations_fund_finance_funds_id_fk" FOREIGN KEY ("fund") REFERENCES "public"."finance_funds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO finance_funds(id) VALUES ('operating_cash'),('deposit_pool');
--> statement-breakpoint
-- Existing confirmed terms are obligations only: no external money, lots or balances.
INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,booking_id,actor_id,reason)
 SELECT 'migration:terms:'||b.id,'migration:0011','charge',b.customer_id,b.id,NULL,'Перенос согласованных условий без оплаты'
 FROM bookings b JOIN LATERAL (SELECT snapshot FROM booking_terms WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1) t ON true
 WHERE b.status='confirmed' AND (t.snapshot->>'finalTotalRub')::bigint>0;
--> statement-breakpoint
INSERT INTO finance_charges(operation_id,booking_id,terms_id,amount_rub)
 SELECT o.id,b.id,t.id,(t.snapshot->>'finalTotalRub')::bigint FROM financial_operations o JOIN bookings b ON b.id=o.booking_id
 JOIN LATERAL (SELECT id,snapshot FROM booking_terms WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1) t ON true WHERE o.request_hash='migration:0011';
--> statement-breakpoint
INSERT INTO audit_logs(actor_id,entity_type,action,entity_id,request_id,details)
 SELECT NULL,'financial_operation','finance.charge',id,gen_random_uuid(),jsonb_build_object('bookingId',booking_id,'source','migration:0011') FROM financial_operations WHERE request_hash='migration:0011';
--> statement-breakpoint
INSERT INTO outbox_jobs(business_key,kind,payload)
 SELECT 'finance:'||id,'finance.posted',jsonb_build_object('id',id,'bookingId',booking_id) FROM financial_operations WHERE request_hash='migration:0011';
--> statement-breakpoint
CREATE FUNCTION finance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Posted financial history is immutable' USING ERRCODE='23514'; END $$;
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['financial_operations','finance_charges','finance_external','finance_lots','finance_allocations','finance_fund_entries'] LOOP
  EXECUTE format('CREATE TRIGGER finance_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION finance_immutable()',table_name);
 END LOOP;
END $$;
