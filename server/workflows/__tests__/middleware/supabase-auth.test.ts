import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const maybeSingle = vi.fn();
const query = {
  select: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
  maybeSingle,
};
query.select.mockReturnValue(query);
query.eq.mockReturnValue(query);
query.order.mockReturnValue(query);
query.limit.mockReturnValue(query);

vi.mock("../../utils/supabase", () => ({
  getSupabaseAdmin: () => ({
    auth: { getUser },
    from: vi.fn(() => query),
  }),
}));

const request = (headers: Record<string, string> = {}) => ({
  auth: undefined,
  id: "request-1",
  header: (name: string) => headers[name.toLowerCase()],
  log: { warn: vi.fn() },
});

describe("Supabase Auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockReturnValue(query);
  });

  it("validates the bearer token and selected tenant membership", async () => {
    getUser.mockResolvedValue({
      data: { user: { id: "user-1", app_metadata: { session_id: "session-1" } } },
      error: null,
    });
    maybeSingle.mockResolvedValue({
      data: { organization_id: "org-1", role: "admin", organizations: { slug: "acme" } },
      error: null,
    });
    const req = request({ authorization: "Bearer valid-token", "x-organization-id": "org-1" });
    const next = vi.fn();
    const { supabaseAuthMiddleware } = await import("../../../lib/auth");

    await supabaseAuthMiddleware(req as never, {} as never, next);

    expect(getUser).toHaveBeenCalledWith("valid-token");
    expect(query.eq).toHaveBeenCalledWith("organization_id", "org-1");
    expect(req.auth).toMatchObject({ userId: "user-1", orgId: "org-1", orgRole: "admin", orgSlug: "acme" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not grant tenant context for an organization without membership", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1", app_metadata: {} } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const req = request({ authorization: "Bearer valid-token", "x-organization-id": "org-other" });
    const { supabaseAuthMiddleware } = await import("../../../lib/auth");

    await supabaseAuthMiddleware(req as never, {} as never, vi.fn());

    expect(req.auth).toMatchObject({ userId: "user-1", orgId: null, orgRole: null });
  });

  it("leaves invalid sessions anonymous", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new Error("invalid token") });
    const req = request({ authorization: "Bearer invalid-token" });
    const { supabaseAuthMiddleware } = await import("../../../lib/auth");

    await supabaseAuthMiddleware(req as never, {} as never, vi.fn());

    expect(req.auth).toMatchObject({ userId: null, orgId: null });
    expect(maybeSingle).not.toHaveBeenCalled();
  });
});
