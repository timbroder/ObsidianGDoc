import { createHash } from "crypto";

/**
 * Returns the hex-encoded SHA-256 hash of a string.
 */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Returns the hex-encoded SHA-256 hash of a Buffer.
 */
export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
