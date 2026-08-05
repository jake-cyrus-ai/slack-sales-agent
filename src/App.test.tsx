import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App from "./App";

describe("configuration surface", () => {
  it("presents the Slack sales agent and retained integrations", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Slack-native sales agent");
    expect(html).toContain("Attio");
    expect(html).toContain("Granola");
    expect(html.toLowerCase()).toContain("autonomous email");
  });
});
