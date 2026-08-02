export interface WaveReassessCommand {
  reason: string;
}

/**
 * Parses the strict wave reassessment control comment:
 *
 * wave-reassess
 * reason: <non-empty reason>
 *
 * Empty lines are ignored, but any additional non-empty content or formatting
 * difference leaves the comment on the ordinary discussion path.
 */
export function parseWaveReassessCommand(body: string): WaveReassessCommand | undefined {
  const nonEmptyLines = body
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

  if (nonEmptyLines.length !== 2 || nonEmptyLines[0] !== "wave-reassess") {
    return undefined;
  }

  const reasonMatch = /^reason: (.+)$/.exec(nonEmptyLines[1]!);
  if (!reasonMatch || reasonMatch[1]!.trim() === "") {
    return undefined;
  }

  return { reason: reasonMatch[1]!.trim() };
}
