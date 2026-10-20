CREATE TABLE "acprouter_machine_bridge_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"credential_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "acprouter_router_enrollment_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"acprouter_user_id" text NOT NULL,
	"acprouter_space_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "acprouter_machines" ADD COLUMN "enrolled_via" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "acprouter_machines" ADD COLUMN "grant_id" text;--> statement-breakpoint
ALTER TABLE "acprouter_machine_bridge_credentials" ADD CONSTRAINT "acprouter_machine_bridge_credentials_machine_id_acprouter_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."acprouter_machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acprouter_machine_bridge_credentials_machine_idx" ON "acprouter_machine_bridge_credentials" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "acprouter_machine_bridge_credentials_hash_idx" ON "acprouter_machine_bridge_credentials" USING btree ("credential_hash");--> statement-breakpoint
CREATE INDEX "acprouter_router_enrollment_grants_user_idx" ON "acprouter_router_enrollment_grants" USING btree ("acprouter_user_id");--> statement-breakpoint
CREATE INDEX "acprouter_router_enrollment_grants_space_idx" ON "acprouter_router_enrollment_grants" USING btree ("acprouter_space_id");--> statement-breakpoint
ALTER TABLE "acprouter_machines" ADD CONSTRAINT "acprouter_machines_grant_id_acprouter_router_enrollment_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."acprouter_router_enrollment_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acprouter_machines_grant_idx" ON "acprouter_machines" USING btree ("grant_id");