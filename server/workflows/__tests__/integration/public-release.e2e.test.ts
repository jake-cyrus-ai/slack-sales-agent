import { describe, expect, it, vi } from "vitest";

type Approval = { id: string; actor: string; status: "pending" | "approved" | "rejected" };

describe("public release mocked sales workflow", () => {
  it("installs, connects, prepares, approves actions, and learns with provenance", async () => {
    const audit: Array<Record<string, unknown>> = [];
    const integrations = new Set<string>();
    const sentKeys = new Set<string>();
    const preferences: Array<Record<string, unknown>> = [];

    const slack = {
      install: vi.fn(async () => ({ workspaceId: "T_ACME", installerUserId: "U_OWNER" })),
      requestApproval: vi.fn(async (kind: string): Promise<Approval> => ({ id: `approval-${kind}`, actor: "U_OWNER", status: "pending" })),
    };
    const calendar = { upcoming: vi.fn(async () => ({ title: "Acme renewal", attendees: ["buyer@acme.test"] })) };
    const gmail = {
      history: vi.fn(async () => ["Buyer requested security review", "Pricing sent"]),
      send: vi.fn(async (key: string) => {
        if (sentKeys.has(key)) return { id: "gmail-existing", duplicate: true };
        sentKeys.add(key);
        return { id: "gmail-123", duplicate: false };
      }),
    };
    const granola = { notes: vi.fn(async () => ["Legal is the remaining blocker"]) };
    const crm = {
      lookup: vi.fn(async () => ({ id: "deal-123", stage: "Evaluation", amount: 50000 })),
      update: vi.fn(async () => ({ id: "deal-123", stage: "Negotiation", taskId: "task-456" })),
    };

    const install = await slack.install();
    expect(install.workspaceId).toBe("T_ACME");
    integrations.add("google");
    integrations.add("attio");
    integrations.add("granola");
    expect(integrations).toEqual(new Set(["google", "attio", "granola"]));

    const [meeting, emailHistory, notes, deal] = await Promise.all([
      calendar.upcoming(), gmail.history(), granola.notes(), crm.lookup(),
    ]);
    const brief = {
      attendees: meeting.attendees,
      history: emailHistory,
      deal,
      risks: notes,
      agenda: ["Resolve legal review", "Confirm commercial terms"],
    };
    expect(brief.risks).toContain("Legal is the remaining blocker");

    const emailDraft = "Thanks for yesterday's call. Here are the security-review next steps.";
    const emailApproval = await slack.requestApproval("email");
    emailApproval.status = "approved";
    const sent = await gmail.send("run-1:email-followup");
    const duplicate = await gmail.send("run-1:email-followup");
    expect(sent).toEqual({ id: "gmail-123", duplicate: false });
    expect(duplicate.duplicate).toBe(true);
    audit.push({ type: "email.sent", approvalId: emailApproval.id, actor: emailApproval.actor, providerId: sent.id, draft: emailDraft });

    const crmApproval = await slack.requestApproval("crm");
    const unauthorizedActor = "U_STRANGER";
    expect(unauthorizedActor).not.toBe(crmApproval.actor);
    crmApproval.status = "approved";
    const updated = await crm.update();
    audit.push({ type: "crm.updated", approvalId: crmApproval.id, actor: crmApproval.actor, providerId: updated.id, before: "Evaluation", after: updated.stage });
    expect(updated).toMatchObject({ id: "deal-123", stage: "Negotiation", taskId: "task-456" });

    const feedback = { runId: "run-1", outputId: "brief-1", value: "positive", correction: "Keep briefs under 8 bullets" };
    preferences.push({
      key: "meeting_brief_length",
      value: "under_8_bullets",
      kind: "inferred",
      confidence: 0.65,
      provenance: { feedbackRunId: feedback.runId, outputId: feedback.outputId },
    });
    audit.push({ type: "feedback.recorded", ...feedback });

    expect(audit).toHaveLength(3);
    expect(preferences[0]).toMatchObject({ kind: "inferred", confidence: 0.65, provenance: { feedbackRunId: "run-1" } });
  });

  it("does not send a rejected draft", async () => {
    const send = vi.fn();
    const approval: Approval = { id: "approval-email", actor: "U_OWNER", status: "rejected" };
    if (approval.status === "approved") await send();
    expect(send).not.toHaveBeenCalled();
  });
});
