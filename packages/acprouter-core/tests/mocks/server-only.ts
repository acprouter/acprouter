// The real `server-only` package throws when imported outside an RSC graph.
// Tests run db logic in plain Node, so alias it to this no-op — same pattern
// `packages/busabase-core/tests/mocks/server-only.ts` already uses.
export {};
