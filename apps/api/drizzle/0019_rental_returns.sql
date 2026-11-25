CREATE TABLE "rental_return_revisions" (
	"booking_id" integer NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"inspection" jsonb NOT NULL,
	"calculation" jsonb,
	"reason" text,
	CONSTRAINT "rental_return_revisions_booking_id_revision_pk" PRIMARY KEY("booking_id","revision"),
	CONSTRAINT "rental_return_revision_positive" CHECK (revision > 0)
);
--> statement-breakpoint
ALTER TABLE "booking_checkouts" DROP CONSTRAINT "booking_checkouts_issued_vehicle_id_unique";--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT "booking_status";--> statement-breakpoint
ALTER TABLE "booking_checkouts" ADD COLUMN "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rental_return_revisions" ADD CONSTRAINT "rental_return_revisions_booking_id_booking_checkouts_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking_checkouts"("booking_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_return_revisions" ADD CONSTRAINT "rental_return_revisions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_vehicle_usage" ON "booking_checkouts" USING btree ("issued_vehicle_id") WHERE returned_at IS NULL AND issued_vehicle_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "booking_status" CHECK (status IN ('confirmed','cancelled','completed','completed_early'));--> statement-breakpoint
ALTER TABLE "booking_checkouts" ADD CONSTRAINT "checkout_return_after_issue" CHECK (returned_at IS NULL OR (issued_at IS NOT NULL AND returned_at >= issued_at));