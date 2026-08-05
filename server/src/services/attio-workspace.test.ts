import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchAttioWorkspaceMetadata } from "./attio-workspace.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("fetchAttioWorkspaceMetadata", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns id+name+slug from JWT claims and skips REST when complete", async () => {
    const token = makeJwt({
      workspace_id: "ws-uuid",
      workspace_name: "Slack Sales Agent",
      workspace_slug: "agent-ai",
    });

    const result = await fetchAttioWorkspaceMetadata(token);

    expect(result).toEqual({ id: "ws-uuid", name: "Slack Sales Agent", slug: "agent-ai" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("falls back to REST /v2/self when JWT lacks slug or name", async () => {
    const token = makeJwt({ workspace_id: "ws-uuid" });
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          workspace_id: "ws-uuid",
          workspace_name: "Slack Sales Agent",
          workspace_slug: "agent-ai",
        },
      }),
    });

    const result = await fetchAttioWorkspaceMetadata(token);

    expect(result).toEqual({ id: "ws-uuid", name: "Slack Sales Agent", slug: "agent-ai" });
    expect(global.fetch).toHaveBeenCalledOnce();
    const fetchCall = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe("https://api.attio.com/v2/self");
    expect(fetchCall[1].headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("returns JWT-only id with null name+slug when REST fails", async () => {
    const token = makeJwt({ workspace_id: "ws-uuid" });
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    const result = await fetchAttioWorkspaceMetadata(token);

    expect(result).toEqual({ id: "ws-uuid", name: null, slug: null });
  });

  it("survives a non-JWT access token by trying REST and tolerating failure", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network"));

    const result = await fetchAttioWorkspaceMetadata("opaque-not-a-jwt");

    expect(result).toEqual({ id: null, name: null, slug: null });
  });

  it("merges JWT + REST: JWT id wins when REST is missing it, REST fills name+slug", async () => {
    const token = makeJwt({ workspace_id: "ws-from-jwt" });
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { workspace_name: "Slack Sales Agent", workspace_slug: "agent-ai" },
      }),
    });

    const result = await fetchAttioWorkspaceMetadata(token);

    expect(result).toEqual({ id: "ws-from-jwt", name: "Slack Sales Agent", slug: "agent-ai" });
  });
});
