import { getAgentCatalog } from "@acprouter/core";
import { AgentsPageClient } from "@acprouter/core/agents-ui";

export default async function AgentsPage() {
  const entries = await getAgentCatalog();

  return <AgentsPageClient entries={entries} apiBasePath="/api/rpc" />;
}
