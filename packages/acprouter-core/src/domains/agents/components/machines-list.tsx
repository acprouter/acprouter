import type { MachineVO } from "@acprouter/contract";

interface MachinesListProps {
  machines: MachineVO[] | null;
}

/**
 * Raw bridge connectivity per machine — separate from `RegisteredAgentsList`
 * (task #10) on purpose: a machine can be online with no agent row yet (an
 * older CLI build that predates the `initialize`-`_meta` channel, or one
 * enrolled with no `intendedAgentSlug`), so this stays the ground truth for
 * "is the bridge itself up" independent of what it's reported about agents.
 * List state now lives in the parent (`AgentsPageClient`) so it can be
 * polled together with `agents.list` from one place — see that file.
 */
export function MachinesList({ machines }: MachinesListProps) {
  if (!machines || machines.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">Machines</h2>
      <div className="flex flex-col divide-y rounded-md border">
        {machines.map((machine) => (
          <div key={machine.id} className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${machine.status === "online" ? "bg-status-connected" : "bg-muted-foreground"}`}
              />
              <span className="text-sm font-medium">{machine.label}</span>
              {machine.platform && (
                <span className="text-xs text-muted-foreground">{machine.platform}</span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{machine.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
