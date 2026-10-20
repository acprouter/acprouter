CREATE TABLE "acprouter_enrollment_completions" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"enrollment_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"consumer_key_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "acprouter_enrollment_completions" ADD CONSTRAINT "acprouter_enrollment_completions_grant_id_acprouter_router_enrollment_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."acprouter_router_enrollment_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acprouter_enrollment_completions" ADD CONSTRAINT "acprouter_enrollment_completions_enrollment_id_acprouter_machines_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."acprouter_machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acprouter_enrollment_completions" ADD CONSTRAINT "acprouter_enrollment_completions_agent_id_acprouter_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."acprouter_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acprouter_enrollment_completions" ADD CONSTRAINT "acprouter_enrollment_completions_consumer_key_id_acprouter_consumer_api_keys_id_fk" FOREIGN KEY ("consumer_key_id") REFERENCES "public"."acprouter_consumer_api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acprouter_enrollment_completions_grant_enrollment_idx" ON "acprouter_enrollment_completions" USING btree ("grant_id","enrollment_id") WHERE "acprouter_enrollment_completions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "acprouter_enrollment_completions_agent_idx" ON "acprouter_enrollment_completions" USING btree ("agent_id");