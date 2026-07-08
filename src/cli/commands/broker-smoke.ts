import * as path from "node:path";
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
import { defaultBackburnerManagementRoot } from "../../utils/paths.js";
import { defaultStderrLogger, type Logger } from "../../utils/logger.js";
import { DEFAULT_GITHUB_BROKER_PORT, readOptionalNumberFlag, readOptionalStringFlag, readStringFlag } from "../options.js";

export async function runBrokerSmokeCli(argv: string[], logger: Logger = defaultStderrLogger): Promise<void> {
  const managementDir = path.resolve(readStringFlag(argv, "--management-dir", defaultBackburnerManagementRoot()));
  const host = "127.0.0.1";
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
    port: DEFAULT_GITHUB_BROKER_PORT,
    logger
  });

  try {
    const initializeResponse = await postJson(server.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "backburner-smoke",
          version: "0.1.0"
        }
      }
    });
    const toolsResponse = await postJson(server.url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });

    process.stdout.write(
      JSON.stringify(
        {
          serverUrl: server.url,
          initialize: initializeResponse.result,
          tools: toolsResponse.result?.tools ?? []
        },
        null,
        2
      ) + "\n"
    );

    const repo = readOptionalStringFlag(argv, "--repo");
    const issueNumber = readOptionalNumberFlag(argv, "--issue-number");
    if (repo && issueNumber) {
      const issueResponse = await postJson(server.url, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "get_issue",
          arguments: {
            repo,
            issueNumber
          }
        }
      });
      process.stdout.write(`${JSON.stringify(issueResponse.result, null, 2)}\n`);
    }
  } finally {
    await server.close();
  }
}


async function postJson(
  url: string,
  payload: Record<string, unknown>
): Promise<{ result?: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Broker smoke request failed with HTTP ${response.status}`);
  }

  return (await response.json()) as { result?: Record<string, unknown> };
}
