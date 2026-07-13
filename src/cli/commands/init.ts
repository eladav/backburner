import { runInitCli } from "../init.js";

export async function runInitCommand(argv: string[]): Promise<void> {
  await runInitCli(argv);
}
