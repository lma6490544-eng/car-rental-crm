CREATE TABLE "vehicle_service_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"performed_on" text NOT NULL,
	"procedure" text NOT NULL,
	"mileage_km" integer,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_mileage" CHECK (mileage_km IS NULL OR mileage_km>=0)
);
--> statement-breakpoint
ALTER TABLE "vehicle_service_records" ADD CONSTRAINT "vehicle_service_records_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_service_records" ADD CONSTRAINT "vehicle_service_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vehicle_service_history" ON "vehicle_service_records" USING btree ("vehicle_id","performed_on");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_normalized_name" ON "vehicle_brands" USING btree (lower(trim("name")));--> statement-breakpoint
CREATE UNIQUE INDEX "model_normalized_name" ON "vehicle_models" USING btree ("brand_id",lower(trim("name")));