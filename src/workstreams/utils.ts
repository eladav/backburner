import { createHash } from "node:crypto";
import { slugify } from "../utils/slug.js";

/**
 * Returns a URL-safe, filesystem-safe, and git-ref-safe slug for a packet ID.
 * Packet IDs are agent-produced and may contain characters like spaces, slashes, or colons.
 *
 * To prevent collisions between different IDs that slugify to the same string
 * (e.g. "foo/bar" and "foo bar") or IDs that are truncated, a short stable hash
 * is appended to the slug.
 */
export function getPacketSlug(packetId: string): string {
  const slug = slugify(packetId);
  const hash = createHash("sha256").update(packetId).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}
