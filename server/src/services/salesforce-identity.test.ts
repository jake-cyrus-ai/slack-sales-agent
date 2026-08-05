import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchSalesforceIdentity } from "./salesforce-identity.js";

const INSTANCE = "https://example.my.salesforce.com";
const TOKEN = "00D000000000000!FakeAccessToken";

describe("fetchSalesforceIdentity", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns orgId + orgName when both endpoints succeed", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ organization_id: "00D000000000ABC", user_id: "005xx" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Id: "00D000000000ABC", Name: "Acme Inc" }),
      });

    const result = await fetchSalesforceIdentity({ accessToken: TOKEN, instanceUrl: INSTANCE });

    expect(result).toEqual({ orgId: "00D000000000ABC", orgName: "Acme Inc" });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0][0]).toBe(`${INSTANCE}/services/oauth2/userinfo`);
    expect(mock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(mock.mock.calls[1][0]).toContain("/sobjects/Organization/00D000000000ABC");
  });

  it("returns orgId with null orgName when Organization sobject lookup fails", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ organization_id: "00D000000000ABC" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });

    const result = await fetchSalesforceIdentity({ accessToken: TOKEN, instanceUrl: INSTANCE });

    expect(result).toEqual({ orgId: "00D000000000ABC", orgName: null });
  });

  it("returns null for both fields when userinfo fails (no follow-up call)", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const result = await fetchSalesforceIdentity({ accessToken: TOKEN, instanceUrl: INSTANCE });

    expect(result).toEqual({ orgId: null, orgName: null });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("tolerates network errors on userinfo and falls back to nulls", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockRejectedValueOnce(new Error("network"));

    const result = await fetchSalesforceIdentity({ accessToken: TOKEN, instanceUrl: INSTANCE });

    expect(result).toEqual({ orgId: null, orgName: null });
  });

  it("treats empty/non-string organization_id from userinfo as missing", async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ organization_id: "" }),
    });

    const result = await fetchSalesforceIdentity({ accessToken: TOKEN, instanceUrl: INSTANCE });

    expect(result).toEqual({ orgId: null, orgName: null });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
