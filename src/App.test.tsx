import { describe, expect, it } from "vitest";
import { integrationNames } from "./integrations";

describe("configuration surface", () => {
  it("presents the Slack sales agent and retained integrations", () => {
    expect(integrationNames).toContain("Slack");
    expect(integrationNames).toContain("Attio");
    expect(integrationNames).toContain("Granola");
  });
});
