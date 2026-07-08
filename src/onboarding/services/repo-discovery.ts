import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandRunner } from "../../utils/command-runner.js";
import type { DiscoveredRepo } from "../types.js";

interface GhRepoEntry {
  name: string;
  owner: { login: string };
  defaultBranchRef?: { name?: string } | null;
}

/** Candidate directories to scan for local git repos. */
const DEFAULT_LOCAL_SEARCH_DIRS: string[] = [
  path.join(os.homedir(), "repos"),
  path.join(os.homedir(), "code"),
  path.join(os.homedir(), "projects"),
  path.join(os.homedir(), "src"),
  path.join(os.homedir(), "work")
];

/**
 * Directory names to skip when scanning for repos. These directories are
 * either too large to scan usefully or are not likely to contain repos.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  ".npm",
  ".yarn",
  "vendor",
  "coverage"
]);

export class RepoDiscoveryService {
  constructor(private readonly commandRunner: CommandRunner) {}

  /**
   * Fetch repos accessible via the authenticated GitHub CLI account.
   *
   * Discovers the user's personal login and all org memberships via the GitHub
   * API, then queries `gh repo list <owner>` for each. Falls back to a plain
   * `gh repo list` (personal repos only) when the API calls fail.
   */
  async discoverGitHubRepos(limit = 100): Promise<DiscoveredRepo[]> {
    const owners = await this.resolveGitHubOwners();

    if (owners.length === 0) {
      return this.listGitHubRepos(undefined, limit);
    }

    const allRepos: DiscoveredRepo[] = [];
    const seen = new Set<string>();

    for (const owner of owners) {
      for (const repo of await this.listGitHubRepos(owner, limit)) {
        const key = `${repo.owner}/${repo.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          allRepos.push(repo);
        }
      }
    }

    return allRepos;
  }

  /** Returns the personal login plus all org logins the user is a member of. */
  private async resolveGitHubOwners(): Promise<string[]> {
    const owners: string[] = [];

    try {
      const userResult = await this.commandRunner.run(
        "gh",
        ["api", "user", "--jq", ".login"],
        { timeoutMs: 10_000 }
      );
      const login = userResult.stdout.trim();
      if (login.length > 0) owners.push(login);
    } catch {
      // ignore — will fall back to unscoped gh repo list
    }

    try {
      const orgsResult = await this.commandRunner.run(
        "gh",
        ["api", "user/orgs", "--jq", ".[].login"],
        { timeoutMs: 10_000 }
      );
      const orgLogins = orgsResult.stdout
        .trim()
        .split(/\r?\n/)
        .filter((s) => s.length > 0);
      owners.push(...orgLogins);
    } catch {
      // ignore — org repos will just be absent
    }

    return owners;
  }

  private async listGitHubRepos(
    owner: string | undefined,
    limit: number
  ): Promise<DiscoveredRepo[]> {
    try {
      const args = [
        "repo",
        "list",
        ...(owner !== undefined ? [owner] : []),
        "--json",
        "name,owner,defaultBranchRef",
        "--limit",
        String(limit)
      ];
      const result = await this.commandRunner.run("gh", args, { timeoutMs: 30_000 });
      const repos: GhRepoEntry[] = JSON.parse(result.stdout);

      return repos.map((repo): DiscoveredRepo => {
        const defaultBranch = repo.defaultBranchRef?.name;
        return {
          owner: repo.owner.login,
          name: repo.name,
          isLocalClone: false,
          ...(defaultBranch !== undefined ? { defaultBranch } : {})
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Scan one or more directories for GitHub-hosted git repositories.
   *
   * Supports two layouts:
   *  - flat:       `<dir>/<repo>/.git`       (e.g. ~/repos/my-repo)
   *  - owner/name: `<dir>/<owner>/<repo>/.git` (e.g. ~/code/myorg/my-repo)
   *
   * Hidden directories and heavy directories (node_modules, dist, …) are
   * skipped. Traversal is bounded to depth 2.
   */
  async discoverLocalRepos(searchDirs?: string[]): Promise<DiscoveredRepo[]> {
    const dirs = searchDirs ?? DEFAULT_LOCAL_SEARCH_DIRS;
    const repos: DiscoveredRepo[] = [];
    const seen = new Set<string>();

    for (const dir of dirs) {
      await this.scanDir(dir, repos, seen);
    }

    return repos;
  }

  /** Merge GitHub repo list with local discoveries, adding localPath where found. */
  mergeRepos(githubRepos: DiscoveredRepo[], localRepos: DiscoveredRepo[]): DiscoveredRepo[] {
    const repoMap = new Map<string, DiscoveredRepo>();

    for (const repo of githubRepos) {
      repoMap.set(`${repo.owner}/${repo.name}`, repo);
    }

    for (const local of localRepos) {
      const key = `${local.owner}/${local.name}`;
      const existing = repoMap.get(key);

      if (existing) {
        repoMap.set(key, {
          ...existing,
          isLocalClone: true,
          ...(local.localPath !== undefined ? { localPath: local.localPath } : {})
        });
      } else {
        repoMap.set(key, local);
      }
    }

    return Array.from(repoMap.values());
  }

  /**
   * Scan `dir` at up to depth 2.
   *
   * - Depth 1: `<dir>/<entry>` — try as a repo; if not, recurse into it as a
   *   potential owner directory (to handle `<dir>/<owner>/<repo>`).
   * - Depth 2: `<dir>/<owner>/<entry>` — try as a repo only (no further recursion).
   */
  private async scanDir(
    dir: string,
    repos: DiscoveredRepo[],
    seen: Set<string>
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldSkip(entry.name)) continue;

      const childPath = path.join(dir, entry.name);

      // Try it as a direct repo first.
      const repo = await this.tryReadGitRepo(childPath);
      if (repo !== undefined) {
        addUnique(repo, repos, seen);
        continue;
      }

      // Not a repo — treat it as a potential owner directory and scan one level
      // deeper (bounded; we do not recurse further from depth-2 entries).
      let subEntries;
      try {
        subEntries = await fs.readdir(childPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        if (shouldSkip(sub.name)) continue;

        const subPath = path.join(childPath, sub.name);
        const subRepo = await this.tryReadGitRepo(subPath);
        if (subRepo !== undefined) {
          addUnique(subRepo, repos, seen);
        }
      }
    }
  }

  private async tryReadGitRepo(dirPath: string): Promise<DiscoveredRepo | undefined> {
    try {
      await fs.access(path.join(dirPath, ".git"));
    } catch {
      return undefined;
    }

    try {
      const result = await this.commandRunner.run(
        "git",
        ["remote", "get-url", "origin"],
        { cwd: dirPath, timeoutMs: 5_000 }
      );

      const parsed = parseGitHubRemoteUrl(result.stdout.trim());
      if (!parsed) return undefined;

      return {
        owner: parsed.owner,
        name: parsed.name,
        localPath: dirPath,
        isLocalClone: true
      };
    } catch {
      return undefined;
    }
  }
}

function shouldSkip(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

function addUnique(repo: DiscoveredRepo, repos: DiscoveredRepo[], seen: Set<string>): void {
  const key = repo.localPath ?? `${repo.owner}/${repo.name}`;
  if (!seen.has(key)) {
    seen.add(key);
    repos.push(repo);
  }
}

function parseGitHubRemoteUrl(url: string): { owner: string; name: string } | undefined {
  // SSH: git@github.com:owner/repo.git
  const ssh = url.match(/git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh?.[1] && ssh[2]) {
    return { owner: ssh[1], name: ssh[2] };
  }

  // HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
  const https = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\s|$)/);
  if (https?.[1] && https[2]) {
    return { owner: https[1], name: https[2] };
  }

  return undefined;
}

export { parseGitHubRemoteUrl };
