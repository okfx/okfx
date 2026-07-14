import { describe, expect, it } from "vitest";

import { LatestRunTracker } from "../src/latest-run.js";

describe("LatestRunTracker", () => {
  it("invalidates older runs for the same key", () => {
    const tracker = new LatestRunTracker();
    const first = tracker.begin("workspace-a");
    const second = tracker.begin("workspace-a");

    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("keeps runs for different keys independent", () => {
    const tracker = new LatestRunTracker();
    const firstWorkspace = tracker.begin("workspace-a");
    const secondWorkspace = tracker.begin("workspace-b");

    expect(firstWorkspace()).toBe(true);
    expect(secondWorkspace()).toBe(true);
  });
});
