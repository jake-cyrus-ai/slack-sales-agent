/**
 * Tests for org-validation Inngest middleware
 *
 * The middleware validates that the userId in an event actually belongs to the
 * organizationId before any function logic runs. It uses a 5-minute in-memory
 * cache to avoid repeated DB round-trips.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NonRetriableError } from "inngest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockVerifyUserInOrganization = vi.fn();
const mockGetSupabaseAdmin = vi.fn(() => ({}));

vi.mock("../../utils/supabase", () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
  verifyUserInOrganization: (
    supabase: unknown,
    userId: string,
    organizationId: string
  ) => mockVerifyUserInOrganization(supabase, userId, organizationId),
}));

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Simulate the middleware's transformInput hook for a given event.
 * We import the middleware after mocks are set up so module caching picks up
 * the mock. The cache is module-level, so we need to re-import to clear it
 * between tests — but vi.resetModules() is too heavy. Instead, we rely on
 * unique userId:orgId pairs in each test to avoid cache collisions, or we
 * use pairs that have been seen before and assert the cached outcome.
 */
async function runMiddleware(eventData: Record<string, unknown>): Promise<void> {
  const { orgValidationMiddleware } = await import("../../middleware/org-validation.js");

  // Reach into the middleware's init() → onFunctionRun() → transformInput() chain
  const middlewareDef = (orgValidationMiddleware as any)._def ?? (orgValidationMiddleware as any);
  const init = middlewareDef.init?.();
  const onFunctionRun = init?.onFunctionRun?.({ ctx: { event: { data: eventData } } });
  const transformInput = onFunctionRun?.transformInput;

  if (transformInput) {
    await transformInput();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("org-validation middleware", () => {
  beforeEach(() => {
    vi.resetModules(); // clear module cache so the in-memory cache resets
    mockVerifyUserInOrganization.mockReset();
    mockGetSupabaseAdmin.mockReset().mockReturnValue({});
  });

  it("allows a valid user-org pair", async () => {
    mockVerifyUserInOrganization.mockResolvedValue(true);

    await expect(
      runMiddleware({ userId: "user-valid", organizationId: "org-valid" })
    ).resolves.toBeUndefined();

    expect(mockVerifyUserInOrganization).toHaveBeenCalledOnce();
  });

  it("throws NonRetriableError for invalid user-org pair", async () => {
    mockVerifyUserInOrganization.mockResolvedValue(false);

    await expect(
      runMiddleware({ userId: "user-bad", organizationId: "org-bad" })
    ).rejects.toThrow(NonRetriableError);

    expect(mockVerifyUserInOrganization).toHaveBeenCalledOnce();
  });

  it("skips validation when userId is missing", async () => {
    await expect(
      runMiddleware({ organizationId: "org-1" })
    ).resolves.toBeUndefined();

    expect(mockVerifyUserInOrganization).not.toHaveBeenCalled();
  });

  it("skips validation when organizationId is missing", async () => {
    await expect(
      runMiddleware({ userId: "user-1" })
    ).resolves.toBeUndefined();

    expect(mockVerifyUserInOrganization).not.toHaveBeenCalled();
  });

  it("skips validation when event data is empty (cron job)", async () => {
    await expect(runMiddleware({})).resolves.toBeUndefined();

    expect(mockVerifyUserInOrganization).not.toHaveBeenCalled();
  });

  it("caches a positive result and avoids redundant DB calls", async () => {
    mockVerifyUserInOrganization.mockResolvedValue(true);

    const data = { userId: "user-cached", organizationId: "org-cached" };

    // First call — hits DB
    await runMiddleware(data);
    // Second call — should use cache (same module instance, not reset between calls)
    await runMiddleware(data);

    // DB called only once despite two runs
    expect(mockVerifyUserInOrganization).toHaveBeenCalledOnce();
  });

  it("caches a negative result and blocks on second call without re-querying", async () => {
    mockVerifyUserInOrganization.mockResolvedValue(false);

    const data = { userId: "user-negative", organizationId: "org-negative" };

    // First call — hits DB, throws
    await expect(runMiddleware(data)).rejects.toThrow(NonRetriableError);

    // Second call — should use cached negative result, throw without DB call
    await expect(runMiddleware(data)).rejects.toThrow(NonRetriableError);

    // DB called only once
    expect(mockVerifyUserInOrganization).toHaveBeenCalledOnce();
  });

  it("only skips when userId is not a string (e.g. number)", async () => {
    await expect(
      runMiddleware({ userId: 123, organizationId: "org-1" })
    ).resolves.toBeUndefined();

    expect(mockVerifyUserInOrganization).not.toHaveBeenCalled();
  });
});
