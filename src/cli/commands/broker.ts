import { ExecFileCommandRunner } from "../../utils/command-runner.js";
import { loadConfig } from "../../config/loader.js";
import { GhCliGitHubGateway } from "../../github/gateway.js";
import { GitHubBrokerService } from "../../github/broker.js";
import { startGitHubBrokerServer } from "../../github/broker-server.js";
import { ComposedBrokerService } from "../../github/composed.js";
import { PlanBreakdownSessionStore } from "../../workstreams/plan-breakdown-generator/store.js";
import { PlanBreakdownToolService } from "../../workstreams/plan-breakdown-generator/tools.js";
import { WaveAssessmentSessionStore } from "../../workstreams/wave-assessment/store.js";
import { WaveAssessmentToolService } from "../../workstreams/wave-assessment/tools.js";
import { defaultBackburnerManagementRoot, resolveUserPath } from "../../utils/paths.js";
import { defaultStderrLogger, type Logger } from "../../utils/logger.js";
import { DEFAULT_GITHUB_BROKER_PORT, readNumberFlag, readStringFlag } from "../options.js";

export async function runBrokerCli(argv: string[], logger: Logger = defaultStderrLogger): Promise<void> {
  const managementDir = resolveUserPath(readStringFlag(argv, "--management-dir", defaultBackburnerManagementRoot()));
  const port = readNumberFlag(argv, "--port", DEFAULT_GITHUB_BROKER_PORT);
  const host = readStringFlag(argv, "--host", "127.0.0.1");
  const config = await loadConfig(managementDir);
  const commandRunner = new ExecFileCommandRunner();
  const gitHubGateway = new GhCliGitHubGateway(commandRunner, config.allowedUsers);
  const githubBrokerService = new GitHubBrokerService(gitHubGateway, config.repos, logger);
  const planBreakdownSessionStore = new PlanBreakdownSessionStore();
  const planBreakdownToolService = new PlanBreakdownToolService(planBreakdownSessionStore, logger);
  const waveAssessmentSessionStore = new WaveAssessmentSessionStore();
  const waveAssessmentToolService = new WaveAssessmentToolService(waveAssessmentSessionStore, logger);
  const brokerService = new ComposedBrokerService([
    githubBrokerService,
    planBreakdownToolService,
    waveAssessmentToolService
  ]);

  const server = await startGitHubBrokerServer({
    brokerService,
    host,
    port,
    logger
  });

  process.stdout.write(`${server.url}\n`);
  await new Promise<void>((resolve, reject) => {
    const shutdown = async () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      try {
        await server.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    const onSigint = () => void shutdown();
    const onSigterm = () => void shutdown();
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });
}
