import type {
  AgentConfig,
  AgentProvider,
  AgentsConfigFile,
  GitHubBrokerConfig,
  PromptProfile,
  PromptsConfigFile,
  RepoConfig,
  ReposConfigFile,
  McpsConfigFile,
  SensorObserves,
  ControllerGrants,
  CapabilityApproval,
  CapabilityScope,
  CapabilityCadence,
  AogSensorCapability,
  AogControllerCapability,
  CapabilityConfig
} from "./schemas.js";

export type {
  AgentConfig,
  AgentProvider,
  AgentsConfigFile,
  GitHubBrokerConfig,
  PromptProfile,
  PromptsConfigFile,
  RepoConfig,
  ReposConfigFile,
  McpsConfigFile,
  SensorObserves,
  ControllerGrants,
  CapabilityApproval,
  CapabilityScope,
  CapabilityCadence,
  AogSensorCapability,
  AogControllerCapability,
  CapabilityConfig
};

export interface McpDependency {
  handle: string;
  smitheryId: string;
}

export interface NormalizedCapabilities {
  sensors: AogSensorCapability[];
  controllers: AogControllerCapability[];
}

// Legacy names for backward compatibility if needed, though plan said to collapse them
export type CodexGitHubBrokerConfig = GitHubBrokerConfig;
export type GeminiGitHubBrokerConfig = GitHubBrokerConfig;
export type ClaudeGitHubBrokerConfig = GitHubBrokerConfig;
export type OpenCodeGitHubBrokerConfig = GitHubBrokerConfig;
export type AntigravityGitHubBrokerConfig = GitHubBrokerConfig;
