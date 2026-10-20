DROP INDEX "acprouter_agents_machine_registry_slug_idx";--> statement-breakpoint
ALTER TABLE "acprouter_agents" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "acprouter_agents_machine_registry_slug_idx" ON "acprouter_agents" USING btree ("machine_id","registry_slug") WHERE "acprouter_agents"."deleted_at" IS NULL;