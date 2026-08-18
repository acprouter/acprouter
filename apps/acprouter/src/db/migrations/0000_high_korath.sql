CREATE TABLE "acprouter_agent_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acprouter_agent_session_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acprouter_agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"consumer_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "acprouter_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"machine_id" text,
	"kind" text NOT NULL,
	"registry_slug" text,
	"distribution" jsonb,
	"label" text NOT NULL,
	"cwd" text,
	"endpoint" text,
	"credential_id" text,
	"detected_version" text,
	"capabilities" jsonb,
	"status_detail" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acprouter_consumer_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"label" text,
	"key_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "acprouter_enrollment_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"intended_agent_slug" text,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acprouter_machines" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"label" text NOT NULL,
	"tunnel_id" text NOT NULL,
	"platform" text,
	"cli_version" text,
	"last_seen_at" timestamp,
	"status" text DEFAULT 'offline' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acprouter_usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text,
	"grantee_id" text,
	"duration_ms" integer,
	"outcome" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acprouter_agent_credentials" ADD CONSTRAINT "acprouter_agent_credentials_agent_id_acprouter_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."acprouter_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acprouter_agent_session_events" ADD CONSTRAINT "acprouter_agent_session_events_session_id_acprouter_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."acprouter_agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acprouter_agent_sessions" ADD CONSTRAINT "acprouter_agent_sessions_agent_id_acprouter_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."acprouter_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acprouter_agents" ADD CONSTRAINT "acprouter_agents_machine_id_acprouter_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."acprouter_machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acprouter_consumer_api_keys" ADD CONSTRAINT "acprouter_consumer_api_keys_agent_id_acprouter_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."acprouter_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acprouter_usage_records" ADD CONSTRAINT "acprouter_usage_records_agent_id_acprouter_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."acprouter_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acprouter_usage_records" ADD CONSTRAINT "acprouter_usage_records_session_id_acprouter_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."acprouter_agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acprouter_agent_credentials_agent_idx" ON "acprouter_agent_credentials" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acprouter_agent_session_events_session_seq_idx" ON "acprouter_agent_session_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "acprouter_agent_session_events_created_at_idx" ON "acprouter_agent_session_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "acprouter_agent_sessions_agent_idx" ON "acprouter_agent_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "acprouter_agent_sessions_consumer_idx" ON "acprouter_agent_sessions" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "acprouter_agents_owner_idx" ON "acprouter_agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "acprouter_agents_machine_idx" ON "acprouter_agents" USING btree ("machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acprouter_agents_machine_registry_slug_idx" ON "acprouter_agents" USING btree ("machine_id","registry_slug");--> statement-breakpoint
CREATE INDEX "acprouter_consumer_api_keys_agent_idx" ON "acprouter_consumer_api_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acprouter_consumer_api_keys_hash_idx" ON "acprouter_consumer_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "acprouter_enrollment_tokens_hash_idx" ON "acprouter_enrollment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "acprouter_machines_owner_idx" ON "acprouter_machines" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "acprouter_machines_tunnel_idx" ON "acprouter_machines" USING btree ("tunnel_id");--> statement-breakpoint
CREATE INDEX "acprouter_usage_records_agent_idx" ON "acprouter_usage_records" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "acprouter_usage_records_grantee_idx" ON "acprouter_usage_records" USING btree ("grantee_id");