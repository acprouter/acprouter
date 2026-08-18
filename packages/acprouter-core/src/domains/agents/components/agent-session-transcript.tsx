"use client";

import { Badge } from "kui/badge";
import { Button } from "kui/button";
import { useEffect, useState } from "react";
import type {
  AgentPermissionBlock,
  AgentToolCallBlock,
  AgentTranscriptBlock,
} from "../hooks/use-agent-session";

const TOOL_STATUS_LABEL: Record<AgentToolCallBlock["status"], string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Done",
  failed: "Failed",
};

function ToolCallCard({ block }: { block: AgentToolCallBlock }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
      <Badge variant={block.status === "failed" ? "destructive" : "secondary"}>
        {TOOL_STATUS_LABEL[block.status]}
      </Badge>
      <span className="truncate">{block.title}</span>
      {block.toolKind && (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{block.toolKind}</span>
      )}
    </div>
  );
}

/** A visible countdown, not just a static timestamp — criterion 12's "clear indication it will time out" bar. Ticks once a second only while this specific card is still `pending`. */
function useCountdown(timeoutAt: string, active: boolean): number {
  const [remainingMs, setRemainingMs] = useState(() => new Date(timeoutAt).getTime() - Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      setRemainingMs(new Date(timeoutAt).getTime() - Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [timeoutAt, active]);
  return remainingMs;
}

function PermissionCard({
  block,
  onAnswer,
}: {
  block: AgentPermissionBlock;
  onAnswer: (optionId: string) => void;
}) {
  const resolution = block.resolution;
  const isPending = resolution === "pending";
  const remainingMs = useCountdown(block.timeoutAt, isPending);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-status-warning/50 bg-status-warning/10 px-3 py-3 text-sm">
      <p className="font-medium text-foreground">{block.title}</p>
      {typeof resolution === "object" ? (
        <p className="text-xs text-muted-foreground">
          Answered:{" "}
          {block.options.find((o) => o.optionId === resolution.optionId)?.name ??
            resolution.optionId}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {block.options.map((option) => (
              <Button
                key={option.optionId}
                size="sm"
                variant={option.kind.startsWith("reject") ? "destructive" : "default"}
                disabled={block.resolution === "answering"}
                onClick={() => onAnswer(option.optionId)}
              >
                {option.name}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {remainingMs > 0
              ? `Times out in ${Math.ceil(remainingMs / 1000)}s if left unanswered.`
              : "Timing out…"}
          </p>
        </>
      )}
    </div>
  );
}

export function AgentSessionTranscript({
  blocks,
  onAnswerPermission,
}: {
  blocks: AgentTranscriptBlock[];
  onAnswerPermission: (block: AgentPermissionBlock, optionId: string) => void;
}) {
  if (blocks.length === 0) {
    return <p className="text-sm text-muted-foreground">Send a prompt to start.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block) => {
        switch (block.kind) {
          case "message":
            return (
              <div
                key={block.id}
                className={
                  block.role === "user"
                    ? "self-end rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
                    : block.variant === "thought"
                      ? "rounded-md border border-dashed border-border px-3 py-2 text-sm italic text-muted-foreground"
                      : "rounded-md bg-muted px-3 py-2 text-sm text-foreground"
                }
              >
                {block.text}
              </div>
            );
          case "tool_call":
            return <ToolCallCard key={block.id} block={block} />;
          case "permission":
            return (
              <PermissionCard
                key={block.id}
                block={block}
                onAnswer={(optionId) => onAnswerPermission(block, optionId)}
              />
            );
          case "ended":
            return (
              <div
                key={block.id}
                className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Session ended — {block.reason}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
