import { resolveAcprouterHome } from "../config";
import { tailLog } from "../daemon/local-daemon";

export interface LogsOptions {
  home?: string;
  lines?: string;
}

export function runLogs(options: LogsOptions): void {
  const home = resolveAcprouterHome(options.home);
  const lines = options.lines ? Number(options.lines) : 30;
  const content = tailLog(home, Number.isFinite(lines) && lines > 0 ? lines : 30);
  console.log(content ?? "No logs yet.");
}
