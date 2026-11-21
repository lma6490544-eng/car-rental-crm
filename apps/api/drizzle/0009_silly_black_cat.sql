ALTER TABLE "vehicles" DROP CONSTRAINT "vehicle_mileage";--> statement-breakpoint
ALTER TABLE "vehicles" ALTER COLUMN "current_mileage_km" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ALTER COLUMN "next_maintenance_due_km" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicle_mileage" CHECK ((current_mileage_km IS NULL OR current_mileage_km>=0) AND (next_maintenance_due_km IS NULL OR next_maintenance_due_km>=0));