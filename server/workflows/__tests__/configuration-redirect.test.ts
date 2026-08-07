import { describe, expect, it } from "vitest";
import { configurationRedirectPath } from "../../lib/configuration-redirect";

describe("configuration redirect", () => {
  it("sends legacy OAuth pages to the root configuration UI", () => {
    expect(configurationRedirectPath({ oauth_success: "true", provider: "slack_bot" }))
      .toBe("/?oauth_success=true&provider=slack_bot");
  });

  it("preserves OAuth callback parameters without accepting objects", () => {
    expect(configurationRedirectPath({ code: "abc", state: "xyz", unsafe: { value: "ignored" } }))
      .toBe("/?code=abc&state=xyz");
  });
});
