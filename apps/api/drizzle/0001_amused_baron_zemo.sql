CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"text" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"display_name" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"inn" text DEFAULT '' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"blocked_reason" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_type" CHECK (type IN ('individual','company')),
	CONSTRAINT "customer_block_reason" CHECK (NOT is_blocked OR length(trim(blocked_reason))>0),
	CONSTRAINT "customer_name" CHECK (length(trim(display_name))>0)
);
--> statement-breakpoint
CREATE TABLE "equivalence_group_models" (
	"group_id" uuid NOT NULL,
	"model_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equivalence_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "equivalence_groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "pricing_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "pricing_groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "vehicle_brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "vehicle_brands_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "vehicle_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pricing_group_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"plate" text NOT NULL,
	"vin" text,
	"year" integer NOT NULL,
	"body_type" text NOT NULL,
	"current_mileage_km" integer NOT NULL,
	"next_maintenance_due_km" integer NOT NULL,
	"is_ready" boolean DEFAULT true NOT NULL,
	"readiness_reason" text DEFAULT '' NOT NULL,
	"needs_wash" boolean DEFAULT false NOT NULL,
	"issue_notes" text DEFAULT '' NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_plate_unique" UNIQUE("plate"),
	CONSTRAINT "vehicles_vin_unique" UNIQUE("vin"),
	CONSTRAINT "vehicle_body" CHECK (body_type IN ('sedan','hatchback','compact_van','cargo_minibus')),
	CONSTRAINT "vehicle_mileage" CHECK (current_mileage_km>=0 AND next_maintenance_due_km>=0),
	CONSTRAINT "vehicle_year" CHECK (year BETWEEN 1900 AND 2100),
	CONSTRAINT "vehicle_readiness" CHECK (is_ready OR length(trim(readiness_reason))>0)
);
--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equivalence_group_models" ADD CONSTRAINT "equivalence_group_models_group_id_equivalence_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."equivalence_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equivalence_group_models" ADD CONSTRAINT "equivalence_group_models_model_id_vehicle_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."vehicle_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_brand_id_vehicle_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."vehicle_brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_pricing_group_id_pricing_groups_id_fk" FOREIGN KEY ("pricing_group_id") REFERENCES "public"."pricing_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_model_id_vehicle_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."vehicle_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_customer" ON "customer_notes" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "equivalence_membership" ON "equivalence_group_models" USING btree ("group_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_brand_name" ON "vehicle_models" USING btree ("brand_id","name");--> statement-breakpoint
CREATE INDEX "vehicles_model" ON "vehicles" USING btree ("model_id");