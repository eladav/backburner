import { formatRunSummary } from "./output.js";
import { CliUsageError } from "./errors.js";
import { runBrokerCli } from "./commands/broker.js";
import { runBrokerSmokeCli } from "./commands/broker-smoke.js";
import { runInitCommand } from "./commands/init.js";
import { runJournalCli } from "./commands/journal.js";
import { runCli } from "./commands/run.js";
import { runLoopCli } from "./commands/run-loop.js";
import { runInteractiveTui, shouldUseRuntimeStatusScreen } from "./commands/tui.js";

const usage =
  'Expected command: backburner run [--code-root <path>] [--management-dir <path>] [--outputs-dir <path>] [--log-dir <path>] [--broker-port <port>] [--headless] [--once] | run-loop ... | broker ... | broker-smoke ... | init [--code-root <path>] [--management-dir <path>] [--outputs-dir <path>] [--log-dir <path>] [--workspaces-dir <path>] [--yes] | journal [--outputs-dir <path>] [--repo <id>] [--workstream <id>] [--issue <n>] [--pr <n>] [--since <ISO>] [--last <n>] [--json] [--verbose]';

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${usage}\n`);
    return;
  }

  if (command === "run") {
    if (shouldUseRuntimeStatusScreen(rest)) {
      await runInteractiveTui([command, ...rest]);
      return;
    }
    const summary = await runCli([command, ...rest]);
    process.stdout.write(formatRunSummary(summary));
    return;
  }

  if (command === "run-loop") {
    if (shouldUseRuntimeStatusScreen(rest)) {
      await runInteractiveTui(["run", ...rest]);
      return;
    }
    await runLoopCli([command, ...rest]);
    return;
  }

  if (command === "broker") {
    await runBrokerCli(rest);
    return;
  }

  if (command === "broker-smoke") {
    await runBrokerSmokeCli(rest);
    return;
  }

  if (command === "init") {
    await runInitCommand(rest);
    return;
  }

  if (command === "journal") {
    await runJournalCli(rest);
    return;
  }

  throw new CliUsageError(usage);
}
