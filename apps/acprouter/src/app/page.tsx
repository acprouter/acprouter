import { redirect } from "next/navigation";

// The MVP has exactly one destination (spec §2b) — Agents is the whole
// product surface for now.
export default function RootPage() {
  redirect("/agents");
}
