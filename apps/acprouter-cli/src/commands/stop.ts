import { resolveAcprouterHome } from "../config";
import { DEFAULT_STOP_TIMEOUT_MS, type StopResult, stopDaemon } from "../daemon/local-daemon";
import { printError, printResult } from "../output";

export interface StopOptions {
  json?: boolean;
  home?: string;
  timeout?: string;
  force?: boolean;
  killTimeout?: string;
}

function parseSeconds(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.ceil(seconds * 1000);
}

export async function runStop(options: StopOptions): Promise<void> {
  const home = resolveAcprouterHome(options.home);
  try {
    const result = await stopDaemon({
      home,
      timeoutMs: parseSeconds(options.timeout, DEFAULT_STOP_TIMEOUT_MS),
      force: options.force,
      killTimeoutMs: parseSeconds(options.killTimeout, 3000),
    });
    printResult<StopResult>(result, options, (r) => {
      if (r.action === "not_running") return ["Not running."];
      if (r.action === "stopped") return [`Stopped (PID ${r.pid}).`];
      return [`Killed (PID ${r.pid}) after graceful stop timed out.`];
    });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error), options);
    process.exitCode = 1;
  }
}
