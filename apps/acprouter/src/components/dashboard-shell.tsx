"use client";

import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "kui/breadcrumb";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "kui/sidebar";
import { Waypoints } from "lucide-react";
import { usePathname } from "next/navigation";
import { DashboardLayout } from "openlib/ui/dashboard";
import type { ReactNode } from "react";
import { Router } from "wouter";
import { getDashboardNav } from "~/config/dashboard";

interface DashboardShellProps {
  children: ReactNode;
  /**
   * Rendered above the shell, already resolved by the caller. ExposureBanner
   * is a `server-only` async Server Component (reads the real request
   * `Host` via `next/headers`) — it must be rendered by the Server Component
   * layout that owns it, never imported into this Client Component's own
   * module scope, so it's threaded through as a prop instead of an import.
   */
  banner?: ReactNode;
}

/**
 * Custom top-left branding slot, standing in for DashboardLayout's built-in
 * `branding` prop. That prop's box (AppSidebar.tsx) is hardcoded to
 * `bg-sidebar-primary`/`text-sidebar-primary-foreground` — kui's
 * `packages/kui/src/styles.css` defines the whole `--sidebar-*` family
 * TWICE (a raw HSL triplet, then again wrapped in its own `hsl(...)`), so
 * `hsl(var(--sidebar-primary))` doubles up into invalid CSS and the box
 * renders fully transparent. `packages/kui` is protected (no edits without
 * explicit sign-off), so this routes around it with `bg-primary`/
 * `text-primary-foreground` instead — verified not to carry the same
 * duplicate-definition bug — rather than papering over a broken box.
 */
function BrandingHeader() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild size="lg" className="data-[slot=sidebar-menu-button]:!p-2">
          <a href="/agents">
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Waypoints className="size-5" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">ACP Router</span>
            </div>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * Sidebar shell for the MVP (spec §2b): "Agents" is still the whole product
 * surface today, so `getDashboardNav()` stays a single flat NavGroup. This
 * deliberately reuses openlib's generic DashboardLayout/AppSidebar/NavMain —
 * the same shell apps/busabase's OSS edition is built on — instead of
 * busabase-core's node-tree/drag-and-drop shell, which solves a sidebar
 * problem (a deep, reorderable folder tree) acprouter doesn't have.
 */
export function DashboardShell({ children, banner }: DashboardShellProps) {
  // openlib's nav (NavMain/SPALink) reads the current route through wouter's
  // useLocation/useSearch, which dereference the browser `location` global for
  // their SSR snapshot unless a `<Router ssrPath>` overrides it — without this,
  // Next's server render of this Client Component throws ("location is not
  // defined"). `usePathname()` is Next's own SSR-safe equivalent; feeding it
  // in as `ssrPath` is the entire fix, no wouter Router config beyond that.
  const pathname = usePathname();

  return (
    <div className="flex h-screen flex-col">
      {banner}
      <div className="min-h-0 flex-1">
        <Router ssrPath={pathname}>
          <DashboardLayout
            navMain={getDashboardNav()}
            sidebarHeader={<BrandingHeader />}
            breadcrumbs={
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>Agents</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            }
            // OSS edition has no login (spec §8.1) — there is no account identity
            // to show, so the user menu is hidden outright rather than fed a fake
            // identity. Kept as an explicit chrome decision passed in here (not
            // hardcoded inside DashboardLayout itself), so a future hosted
            // adapter can flip it on with a real session, without touching this
            // shared shell.
            hideUserMenu
            user={{ name: "", email: "", avatar: "" }}
            onSignOut={() => {}}
          >
            {children}
          </DashboardLayout>
        </Router>
      </div>
    </div>
  );
}
