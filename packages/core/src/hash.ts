import { createHash } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function contentHash(input: string | Buffer): string {
  return `sha256:${sha256Hex(input)}`;
}
