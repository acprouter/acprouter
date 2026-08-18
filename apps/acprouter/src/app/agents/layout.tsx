import { DashboardShell } from "~/components/dashboard-shell";
import { ExposureBanner } from "~/components/exposure-banner";

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell banner={<ExposureBanner />}>{children}</DashboardShell>;
}
