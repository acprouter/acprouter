import { resolveAcprouterHome } from "../config";
import { DEFAULT_STOP_TIMEOUT_MS, startDetached, stopDaemon } from "../daemon/local-daemon";
import { printError, printResult } from "../output";

export interface RestartOptions {
  json?: boolean;
  home?: string;
  timeout?: string;
  force?: boolean;
}

/** Graceful stop (with timeout) -> detached start, per spec §5.4b. */
export async function runRestart(options: RestartOptions): Promise<void> {
  const home = resolveAcprouterHome(options.home);
  try {
    const timeoutMs = options.timeout
      ? Math.ceil(Number(options.timeout) * 1000)
      : DEFAULT_STOP_TIMEOUT_MS;
    await stopDaemon({ home, timeoutMs, force: options.force });
    const started = await startDetached({ home });
    printResult(
      { action: "restarted" as const, pid: started.pid, logPath: started.logPath },
      options,
      (r) => [`Restarted. PID: ${r.pid}.`, `Logs: ${r.logPath}`],
    );
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error), options);
    process.exitCode = 1;
  }
}
