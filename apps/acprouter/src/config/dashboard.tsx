import { Bot } from "lucide-react";
import type { NavGroup } from "openlib/ui/dashboard";

/**
 * Flat nav config — acprouter's whole product surface today is "Agents"
 * (spec §2b), so a single unlabeled group is enough. Deliberately not
 * busabase-core's node-tree/drag-and-drop nav: that solves a much bigger,
 * reorderable-folder sidebar acprouter doesn't have.
 */
export function getDashboardNav(): NavGroup[] {
  return [
    {
      label: "",
      items: [
        {
          title: "Agents",
          url: "/agents",
          icon: Bot,
        },
      ],
    },
  ];
}
