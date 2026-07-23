export function parseGitHubRemoteUrl(url: string): { owner: string; name: string } | undefined {
  // git@github.com:owner/name.git
  // https://github.com/owner/name.git
  // https://github.com/owner/name

  const sshRegex = /^git@github\.com:([^/]+)\/([^/]+)\.git$/;
  const sshUrlRegex = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)\.git$/;
  const httpsRegex = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/;

  const sshMatch = url.match(sshRegex);
  if (sshMatch) {
    return { owner: sshMatch[1]!, name: sshMatch[2]! };
  }

  const sshUrlMatch = url.match(sshUrlRegex);
  if (sshUrlMatch) {
    return { owner: sshUrlMatch[1]!, name: sshUrlMatch[2]! };
  }

  const httpsMatch = url.match(httpsRegex);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, name: httpsMatch[2]! };
  }

  return undefined;
}
