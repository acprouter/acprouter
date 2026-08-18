// The real `server-only` package throws when imported outside an RSC graph.
// Tests run route handlers in plain Node, so alias it to this no-op — same
// pattern `apps/busabase/tests/mocks/server-only.ts` already uses.
export {};
