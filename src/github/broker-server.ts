import * as http from "node:http";
import { URL } from "node:url";
import { toPrettyJson } from "../utils/json.js";
import type { Logger } from "../utils/logger.js";
import { createModelVisibleSuccessText } from "./broker-model-content.js";
import type { BrokerToolService, BrokerToolCallResult } from "./types.js";

const MCP_PATH = "/mcp";

export interface StartGitHubBrokerServerOptions {
  brokerService: BrokerToolService;
  host: string;
  port: number;
  logger: Logger;
}

export interface StartedGitHubBrokerServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface BrokerHttpRequest {
  method: string;
  path: string;
  body?: string;
}

export interface BrokerHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export async function startGitHubBrokerServer(
  options: StartGitHubBrokerServerOptions
): Promise<StartedGitHubBrokerServer> {
  const server = http.createServer(async (request, response) => {
    try {
      const httpResponse = await handleBrokerHttpRequest(
        {
          method: request.method ?? "GET",
          path: request.url ?? "/",
          body: await readRequestBody(request)
        },
        options.brokerService
      );
      response.writeHead(httpResponse.statusCode, httpResponse.headers);
      response.end(httpResponse.body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn(`GitHub broker request failed: ${message}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      response.end(
        toPrettyJson(
          jsonRpcError(null, -32603, "Internal server error")
        )
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Broker server did not expose a TCP address");
  }

  const url = `http://${options.host}:${address.port}${MCP_PATH}`;
  options.logger.info(`GitHub broker MCP listening on ${url}`);

  return {
    host: options.host,
    port: address.port,
    url,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

export async function handleBrokerHttpRequest(
  request: BrokerHttpRequest,
  brokerService: BrokerToolService
): Promise<BrokerHttpResponse> {
  try {
    return await handleBrokerHttpRequestInner(request, brokerService);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      statusCode: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: toPrettyJson(jsonRpcError(null, -32700, message))
    };
  }
}

async function handleBrokerHttpRequestInner(
  request: BrokerHttpRequest,
  brokerService: BrokerToolService
): Promise<BrokerHttpResponse> {
  const url = new URL(request.path, "http://localhost");
  if (request.method === "GET" && url.pathname === "/") {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: toPrettyJson({
        ok: true,
        service: "backburner-github-broker",
        mcpPath: MCP_PATH
      })
    };
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: toPrettyJson({ ok: true })
    };
  }

  if (request.method === "GET" && url.pathname === MCP_PATH) {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: toPrettyJson({
        ok: true,
        transport: "json-rpc",
        method: "POST",
        path: MCP_PATH
      })
    };
  }

  if (request.method !== "POST" || url.pathname !== MCP_PATH) {
    return {
      statusCode: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: toPrettyJson({ error: "Not found" })
    };
  }

  const payload = readJsonRpcRequest(request.body);
  if (payload.method === "notifications/initialized") {
    return {
      statusCode: 202,
      headers: {}
    };
  }

  if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: toPrettyJson(jsonRpcError(payload.id ?? null, -32600, "Invalid JSON-RPC request"))
    };
  }

  const result = await dispatchJsonRpc(payload, brokerService);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: toPrettyJson(result)
  };
}

async function dispatchJsonRpc(
  request: JsonRpcRequest,
  brokerService: BrokerToolService
): Promise<Record<string, unknown>> {
  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "backburner-github-broker",
            version: "0.1.0"
          },
          instructions:
            "Use the typed GitHub broker tools for managed repositories instead of invoking gh directly."
        }
      };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          tools: brokerService.listTools()
        }
      };
    case "tools/call": {
      const params = expectParamsObject(request.params, '"tools/call" params must be an object');
      const name = expectString(params.name, '"tools/call" requires a string "name"');
      const toolResult = await brokerService.callTool(name, params.arguments);

      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: toolResult.ok
          ? {
              content: [
                {
                  type: "text",
                  text: createModelVisibleSuccessText(toolResult)
                }
              ],
              structuredContent: toolResult.result,
              isError: false
            }
          : {
              content: [
                {
                  type: "text",
                  text: `GitHub broker tool "${toolResult.tool}" failed: ${toolResult.error.message}`
                }
              ],
              structuredContent: toolResult,
              isError: true
            }
      };
    }
    default:
      return jsonRpcError(request.id ?? null, -32601, `Method "${request.method}" not found`);
  }
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", (error) => {
      reject(error);
    });
  });
}

function jsonRpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

function readJsonRpcRequest(body?: string): JsonRpcRequest {
  if (!body) {
    return {};
  }

  try {
    const payload = JSON.parse(body);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return {};
    }
    return payload as JsonRpcRequest;
  } catch {
    return {};
  }
}

function expectParamsObject(params: unknown, message: string): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error(message);
  }
  return params as Record<string, unknown>;
}

function expectString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}
