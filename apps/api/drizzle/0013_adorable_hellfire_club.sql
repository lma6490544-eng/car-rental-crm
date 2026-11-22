CREATE TABLE "booking_checkouts" (
	"booking_id" integer PRIMARY KEY NOT NULL,
	"started_by" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"act_revision_id" integer,
	"act_signed_at" timestamp with time zone,
	"act_signed_by" integer,
	"issued_at" timestamp with time zone,
	"issued_by" integer,
	"issued_vehicle_id" integer,
	"issued_contract_id" integer,
	CONSTRAINT "booking_checkouts_issued_vehicle_id_unique" UNIQUE("issued_vehicle_id"),
	CONSTRAINT "checkout_act_signature" CHECK (num_nonnulls(act_revision_id,act_signed_at,act_signed_by) IN (0,3)),
	CONSTRAINT "checkout_issuance" CHECK (num_nonnulls(issued_at,issued_by,issued_vehicle_id,issued_contract_id) IN (0,4))
);
--> statement-breakpoint
ALTER TABLE "booking_checkouts" ADD CONSTRAINT "booking_checkouts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_checkouts" ADD CONSTRAINT "booking_checkouts_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_checkouts" ADD CONSTRAINT "booking_checkouts_act_revision_id_inspection_revisions_id_fk" FOREIGN KEY ("act_revision_id") REFERENCES "public"."inspection_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_checkouts" ADD CONSTRAINT "booking_checkouts_act_signed_by_users_id_fk" FOREIGN KEY ("act_signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_checkouts" ADD CONSTRAINT "booking_checkouts_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_checkouts" ADD CONSTRAINT "booking_checkouts_issued_vehicle_id_vehicles_id_fk" FOREIGN KEY ("issued_vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_checkouts" ADD CONSTRAINT "booking_checkouts_issued_contract_id_contract_versions_id_fk" FOREIGN KEY ("issued_contract_id") REFERENCES "public"."contract_versions"("id") ON DELETE no action ON UPDATE no action;