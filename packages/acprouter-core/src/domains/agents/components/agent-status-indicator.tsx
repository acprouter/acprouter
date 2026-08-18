import type { AgentStatus } from "@acprouter/contract";

const STATUS_LABEL: Record<AgentStatus, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  // Must literally read as sign-in needed, never "error" (acceptance
  // criterion 10) — this is the MOST likely first-run state (spec §5.2a:
  // 18/31 real ACP agents demand auth), not an edge case.
  auth_required: "Sign-in needed",
  error: "Error",
};

const STATUS_DOT_CLASS: Record<AgentStatus, string> = {
  connected: "bg-status-connected",
  disconnected: "bg-muted-foreground",
  auth_required: "bg-status-warning",
  error: "bg-destructive",
};

interface AgentStatusIndicatorProps {
  status: AgentStatus;
  /** The acceptance-criterion-10 "exact next step" — shown inline (and as a hover tooltip) for the two states where it exists, never for `connected`/`disconnected`. */
  statusDetail: string | null;
}

/**
 * One of the four REAL states (spec §5.2a, acceptance criterion 10) — never
 * a boolean dot. `auth_required` and `error` look visually distinct (amber
 * vs. destructive-red) and each carries its own detail string, so "connected
 * but needs sign-in" is never confusable with "actually broken".
 */
export function AgentStatusIndicator({ status, statusDetail }: AgentStatusIndicatorProps) {
  const showDetail = statusDetail && (status === "auth_required" || status === "error");

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[status]}`} />
      <span className="text-sm font-medium">{STATUS_LABEL[status]}</span>
      {showDetail && (
        <span
          className={`truncate text-xs ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}
          title={statusDetail ?? undefined}
        >
          — {statusDetail}
        </span>
      )}
    </div>
  );
}
