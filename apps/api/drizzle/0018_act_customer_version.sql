DROP INDEX "act_revision_template";--> statement-breakpoint
ALTER TABLE "inspection_act_versions" ADD COLUMN "customer_version" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "act_revision_template_customer" ON "inspection_act_versions" USING btree ("inspection_revision_id","booking_version","template_version","customer_version");