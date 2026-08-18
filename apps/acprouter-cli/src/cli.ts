#!/usr/bin/env node
import { Command } from "commander";
import { runAgentsLs } from "./commands/agents-ls";
import { runConnect } from "./commands/connect";
import { runLogs } from "./commands/logs";
import { runRestart } from "./commands/restart";
import { runStatus } from "./commands/status";
import { runStop } from "./commands/stop";
import { RUN_BRIDGE_COMMAND } from "./daemon/local-daemon";
import { runBridgeProcess } from "./daemon/runner";

// Handled before Commander ever parses argv: this must never appear in
// --help, and must never go through user-facing option validation. See
// `RUN_BRIDGE_COMMAND`'s docstring for why the bridge process is the CLI
// re-invoking itself rather than a separately-resolved runner file.
if (process.argv[2] === RUN_BRIDGE_COMMAND) {
  runBridgeProcess();
} else {
  const program = new Command();
  program
    .name("acprouter")
    .description("ACP Router local bridge — put this machine's agents on the network");

  program
    .command("connect")
    .description("Connect this machine's agents to a Router (safe to re-run)")
    .option("--server <url>", "Router URL")
    .option("--token <token>", "one-time enrollment token")
    .option("--dir <path>", "working directory for bridged agents (default: current directory)")
    .option("--foreground", "run in the foreground instead of detaching")
    .option("--json", "output as JSON")
    .option("--home <path>", "acprouter home directory (default: ~/.acprouter)")
    .action(runConnect);

  program
    .command("status")
    .description("Show bridge status")
    .option("--json", "output as JSON")
    .option("--home <path>", "acprouter home directory")
    .action(runStatus);

  program
    .command("restart")
    .description("Restart the bridge")
    .option("--json", "output as JSON")
    .option("--home <path>", "acprouter home directory")
    .option("--timeout <seconds>", "graceful-stop timeout before failing")
    .option("--force", "escalate to SIGKILL if graceful stop times out")
    .action(runRestart);

  program
    .command("stop")
    .description("Stop the bridge")
    .option("--json", "output as JSON")
    .option("--home <path>", "acprouter home directory")
    .option("--timeout <seconds>", "graceful-stop timeout before failing")
    .option("--force", "escalate to SIGKILL if graceful stop times out")
    .option("--kill-timeout <seconds>", "wait after SIGKILL before failing")
    .action(runStop);

  program
    .command("logs")
    .description("Show recent bridge logs")
    .option("--lines <n>", "number of lines to show (default: 30)")
    .option("--home <path>", "acprouter home directory")
    .action(runLogs);

  const agents = program.command("agents").description("Inspect this machine's agents");
  agents
    .command("ls")
    .description("List agents detected on this machine")
    .option("--json", "output as JSON")
    .option("--home <path>", "acprouter home directory")
    .action(runAgentsLs);

  await program.parseAsync(process.argv);
}
