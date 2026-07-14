import { realpathSync } from "node:fs";

export function identifiesFile(path: string | undefined, expectedPath: string): boolean {
  if (!path) {
    return false;
  }

  try {
    return realpathSync(path) === realpathSync(expectedPath);
  } catch {
    return false;
  }
}
