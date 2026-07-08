import * as path from "node:path";
import { JournalReader, JournalService } from "../../journal/index.js";
import { renderJournalEntries } from "../../journal/renderer.js";
import { defaultBackburnerOutputsRoot, resolveOutputsJournalRoot } from "../../utils/paths.js";
import { CliUsageError } from "../errors.js";
import { readOptionalStringFlag, readStringFlag } from "../options.js";

export async function runJournalCli(argv: string[], injectedJournal?: JournalService): Promise<void> {
  const outputsDir = path.resolve(readStringFlag(argv, "--outputs-dir", defaultBackburnerOutputsRoot()));
  const journalDir = resolveOutputsJournalRoot(outputsDir);
  const reader = injectedJournal ? injectedJournal.reader : new JournalReader(journalDir);

  const repoId = readOptionalStringFlag(argv, "--repo");
  const workstreamId = readOptionalStringFlag(argv, "--workstream");
  const issueRaw = readOptionalStringFlag(argv, "--issue");
  const prRaw = readOptionalStringFlag(argv, "--pr");
  const since = readOptionalStringFlag(argv, "--since");
  const lastRaw = readOptionalStringFlag(argv, "--last");
  const isJson = argv.includes("--json");
  const isVerbose = argv.includes("--verbose");

  const issueNumber = issueRaw !== undefined ? Number(issueRaw) : undefined;
  const prNumber = prRaw !== undefined ? Number(prRaw) : undefined;
  const limit = lastRaw !== undefined ? Number(lastRaw) : 50;

  if (issueRaw !== undefined && (!Number.isInteger(issueNumber!) || issueNumber! <= 0)) {
    throw new CliUsageError(`--issue must be a positive integer, got: ${issueRaw}`);
  }
  if (prRaw !== undefined && (!Number.isInteger(prNumber!) || prNumber! <= 0)) {
    throw new CliUsageError(`--pr must be a positive integer, got: ${prRaw}`);
  }
  if (lastRaw !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new CliUsageError(`--last must be a positive integer, got: ${lastRaw}`);
  }
  if (since !== undefined && isNaN(new Date(since).getTime())) {
    throw new CliUsageError(`--since must be a valid ISO date, got: ${since}`);
  }

  const entries = await reader.query({
    ...(repoId !== undefined ? { repoId } : {}),
    ...(workstreamId !== undefined ? { workstreamId } : {}),
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(since !== undefined ? { since } : {}),
    limit
  });

  process.stdout.write(renderJournalEntries(entries, { json: isJson, verbose: isVerbose }));
}
