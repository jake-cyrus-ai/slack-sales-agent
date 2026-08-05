/**
 * Prospect dossier → CRM sync.
 *
 * Triggered on dossier finalization. Detects the org's connected CRM
 * (Attio preferred, Salesforce fallback) and writes records:
 *
 *   - Attio  → Person always. If the prospect provided an email,
 *              also creates Company + Deal (Lead stage) via the Attio agent.
 *   - SFDC   → Lead.
 *
 * The created record is referenced from prospect_dossiers.crm_deal_id so the
 * Slack post + Autonomous page can deep-link.
 */

import { logger } from "../logger";
import { getSupabaseAdmin } from "../supabase";
import { recordDossierCrmDeal, type ProspectDossier } from "./dossier";
import { hasAttioConnection, getAttioClient } from "../../src/services/attio-client.js";
import { runAttioAgent } from "../../src/attio/index.js";
import type { UserInfo } from "../../src/agent/system-prompt.js";
import {
  isSalesforceConfiguredForOrg,
  getSalesforceConnection,
} from "../../src/salesforce/client.js";
import type { ConversationStage } from "../../inngest/utils/email-thread-context";

/** Map conversation stages to Attio pipeline stage names. */
const STAGE_TO_ATTIO: Record<ConversationStage, string> = {
  intro: "Lead",
  meeting_scheduled: "Connected",
  discovery: "Discovery",
  demo: "Demo",
  negotiation: "Negotiating/Procurement",
  procurement: "Negotiating/Procurement",
  proposal: "Signature",
  closed_won: "Won",
  closed_lost: "Lost",
  nurture: "Keep Warm",
};

const log = logger.child({ component: "prospect-context-crm-sync" });

// ---------------------------------------------------------------------------
// CRM deduplication lookup
// ---------------------------------------------------------------------------

export interface ExistingCrmRecord {
  existingContact: { id: string; email: string; full_name: string | null } | null;
  existingDossierCrmId: string | null;
  existingCrmProvider: string | null;
  existingAttioWorkspaceId: string | null;
  existingSalesforceOrgId: string | null;
}

/**
 * Check whether we already have a CRM record for this email + org.
 *
 * 1. Queries `contacts` for an existing row with this email + org.
 * 2. Queries `prospect_dossiers` for an existing row with this
 *    `contact_email` + org that already has a `crm_deal_id`.
 *
 * When `preferredProvider` is set, the dossier query is scoped to that
 * provider — dedup hits on the non-primary CRM are ignored so the dossier
 * gets stamped with the primary CRM (Attio when both are connected) instead
 * of being permanently locked to whichever record happened to exist first.
 *
 * Designed to be fast (< 1s) and never block the pipeline — both queries
 * run in parallel with a hard 2s timeout.
 */
export async function lookupExistingCrmRecord(
  organizationId: string,
  email: string,
  preferredProvider?: "attio" | "salesforce" | "hubspot",
): Promise<ExistingCrmRecord> {
  const supabase = getSupabaseAdmin();
  const normalizedEmail = email.toLowerCase();

  try {
    let dossierQuery = supabase
      .from("prospect_dossiers")
      .select("crm_deal_id, crm_provider, attio_workspace_id, salesforce_org_id")
      .eq("organization_id", organizationId)
      .eq("contact_email", normalizedEmail)
      .not("crm_deal_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (preferredProvider) {
      dossierQuery = dossierQuery.eq("crm_provider", preferredProvider);
    }

    const [contactResult, dossierResult] = await Promise.race([
      Promise.all([
        supabase
          .from("contacts")
          .select("id, email, full_name")
          .eq("organization_id", organizationId)
          .eq("email", normalizedEmail)
          .limit(1)
          .maybeSingle(),
        dossierQuery.maybeSingle(),
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("CRM dedup lookup timed out")), 2_000),
      ),
    ]);

    if (contactResult.error) {
      log.warn({ err: contactResult.error, organizationId, email: normalizedEmail }, "Contact dedup query failed");
    }
    if (dossierResult.error) {
      log.warn({ err: dossierResult.error, organizationId, email: normalizedEmail }, "Dossier dedup query failed");
    }

    const existingContact = contactResult.data
      ? { id: contactResult.data.id, email: contactResult.data.email, full_name: contactResult.data.full_name }
      : null;

    return {
      existingContact,
      existingDossierCrmId: dossierResult.data?.crm_deal_id ?? null,
      existingCrmProvider: dossierResult.data?.crm_provider ?? null,
      existingAttioWorkspaceId: dossierResult.data?.attio_workspace_id ?? null,
      existingSalesforceOrgId: dossierResult.data?.salesforce_org_id ?? null,
    };
  } catch (err) {
    log.warn({ err, organizationId, email: normalizedEmail }, "CRM dedup lookup failed (timeout or unexpected error)");
    return {
      existingContact: null,
      existingDossierCrmId: null,
      existingCrmProvider: null,
      existingAttioWorkspaceId: null,
      existingSalesforceOrgId: null,
    };
  }
}

interface AttioCallContent {
  type: string;
  text?: string;
}

function extractAttioRecordId(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const item of content as AttioCallContent[]) {
    if (item.type === "text" && typeof item.text === "string") {
      const m =
        item.text.match(/record_id:\s*([a-f0-9-]{36})/i) ??
        item.text.match(/"record_id"\s*:\s*"([a-f0-9-]{36})"/i) ??
        item.text.match(/\bid:\s*([a-f0-9-]{36})/i);
      if (m) return m[1];
    }
  }
  return null;
}

type AttioMcpClient = NonNullable<Awaited<ReturnType<typeof getAttioClient>>>;

/**
 * Search Attio Companies by name and return the first match's record_id, or
 * null if not found / the call fails. Used to link a Person to a Company
 * record so prospects aren't orphaned in Attio's relationship graph.
 *
 * Mirrors the search-records → record_id parse pattern in
 * server/src/attio/tools/create-deal.ts (which does the same for Deal
 * creation's associated_company link).
 */
async function findAttioCompanyId(
  client: AttioMcpClient,
  companyName: string,
  dossierId: string,
): Promise<string | null> {
  try {
    const result = await client.callTool({
      name: "search-records",
      arguments: { object: "companies", query: companyName },
    });
    if (result.isError) {
      log.warn(
        { dossierId, companyName, content: result.content },
        "Attio companies search returned isError",
      );
      return null;
    }
    return extractAttioRecordId(result.content);
  } catch (err) {
    log.warn({ err, dossierId, companyName }, "Attio companies search threw");
    return null;
  }
}

function dossierNotes(dossier: ProspectDossier, orgName: string | null): string {
  // Attribution preamble: Attio's `created_by` field on a Person is bound to
  // the OAuth-connected user (e.g. Hadi), and there's no MCP knob to override
  // it. So make the source obvious in the note instead — sellers opening the
  // Person record will see it leads with "Auto-created by the Slack Sales Agent Autonomous
  // prospect chatbot for {org}", regardless of whose name is on the system
  // field.
  const lines: string[] = [
    `Auto-created by the Slack Sales Agent Autonomous prospect chatbot${orgName ? ` for ${orgName}` : ""}.`,
    `Generated ${new Date().toISOString()}.`,
    "",
    "—",
    "",
  ];
  if (dossier.fitScore !== null) {
    lines.push(`Fit: ${dossier.fitScore}/100 (${dossier.fitBand ?? "—"})`);
  }
  if (dossier.strengths.length > 0) {
    lines.push("");
    lines.push("Strengths:");
    for (const s of dossier.strengths) lines.push(`- ${s}`);
  }
  if (dossier.gaps.length > 0) {
    lines.push("");
    lines.push("Gaps:");
    for (const g of dossier.gaps) lines.push(`- ${g}`);
  }
  if (dossier.currentState) {
    lines.push("");
    lines.push("Current State:");
    lines.push(dossier.currentState);
  }
  return lines.join("\n");
}

/**
 * Split a free-form contact name into Attio's required first/last fields.
 * Attio's People `name` attribute requires both first_name and last_name as
 * separate strings; full_name alone is rejected with a 422.
 */
function splitContactName(full: string): { first: string; last: string; full: string } {
  const trimmed = full.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    // Single name (e.g. "Cher") — Attio still requires last_name; fall back to first.
    return { first: parts[0], last: parts[0], full: trimmed };
  }
  return {
    first: parts[0],
    last: parts.slice(1).join(" "),
    full: trimmed,
  };
}

async function syncToAttio(dossier: ProspectDossier): Promise<boolean> {
  const client = await getAttioClient(dossier.organizationId);
  if (!client) return false;

  // Fetch org row + Attio creds row once. The org row carries the display
  // name (note attribution) and the legacy settings.attio_workspace_slug
  // fallback. The creds row carries the auto-derived workspace_id (stamped
  // on the dossier so a future workspace switch can detect orphaned deals)
  // and workspace_slug (preferred deep-link source).
  const supabase = getSupabaseAdmin();
  const [orgResult, credsResult] = await Promise.all([
    supabase
      .from("organizations")
      .select("name, settings")
      .eq("id", dossier.organizationId)
      .maybeSingle(),
    supabase
      .from("attio_credentials")
      .select("attio_workspace_id, workspace_slug")
      .eq("organization_id", dossier.organizationId)
      .maybeSingle(),
  ]);
  const orgRow = (orgResult.data ?? null) as { name?: string; settings?: Record<string, unknown> | null } | null;
  const credsRow = (credsResult.data ?? null) as { attio_workspace_id?: string | null; workspace_slug?: string | null } | null;
  const orgName = orgRow?.name ?? null;
  const credsWorkspaceId = credsRow?.attio_workspace_id ?? null;

  try {
    const values: Record<string, unknown[]> = {};
    if (dossier.contactName) {
      const n = splitContactName(dossier.contactName);
      values.name = [{ first_name: n.first, last_name: n.last, full_name: n.full }];
    }
    if (dossier.contactEmail) values.email_addresses = [{ email_address: dossier.contactEmail }];
    if (dossier.contactRole) values.job_title = [{ value: dossier.contactRole }];

    // Link the Person to a Company record. Attio's `company` attribute is a
    // record-link, not a string — search by name, link if found, skip if not.
    // If the prospect is in the pipeline, the Company + Deal are created
    // further below via runAttioAgent.
    let cachedCompanyId: string | null = null;
    if (dossier.contactCompany) {
      cachedCompanyId = await findAttioCompanyId(client, dossier.contactCompany, dossier.id);
      if (cachedCompanyId) {
        values.company = [{ target_object: "companies", target_record_id: cachedCompanyId }];
      } else {
        log.info(
          { dossierId: dossier.id, companyName: dossier.contactCompany },
          "Attio company not found by name; creating Person without company link (note still mentions it)",
        );
      }
    }

    const result = await client.callTool({
      name: "create-record",
      arguments: { object: "people", values },
    });

    // Handle duplicate email conflict — Attio returns an error with the
    // existing record ID when email_addresses already exists in the system.
    // Extract that ID and continue with the existing Person record.
    let recordId: string | null = null;

    if (result.isError) {
      const errorText = Array.isArray(result.content)
        ? (result.content as AttioCallContent[]).find(c => c.type === "text")?.text ?? ""
        : "";
      const conflictMatch = errorText.match(/[Cc]onflicting record IDs?:\s*"([a-f0-9-]{36})"/);
      if (conflictMatch) {
        recordId = conflictMatch[1];
        log.info(
          { dossierId: dossier.id, existingRecordId: recordId },
          "Attio Person already exists for this email — using existing record",
        );
      } else {
        log.error(
          { dossierId: dossier.id, content: result.content },
          "Attio create-record returned isError",
        );
        return false;
      }
    } else {
      recordId = extractAttioRecordId(result.content);
    }
    if (!recordId) {
      log.warn(
        { dossierId: dossier.id },
        "Attio create-record succeeded but no record_id parsed; skipping deep-link",
      );
      return true;
    }

    // Try to attach a note with strengths/gaps/current_state for searchability.
    const notes = dossierNotes(dossier, orgName);
    if (notes) {
      try {
        await client.callTool({
          name: "create-note",
          arguments: {
            title: `Sales Agent chat dossier${dossier.contactName ? ` — ${dossier.contactName}` : ""}`,
            content: notes,
            parent_object: "people",
            parent_record_id: recordId,
          },
        });
      } catch (err) {
        log.warn({ err, dossierId: dossier.id }, "Failed to attach Attio note (non-blocking)");
      }
    }

    // --- Company + Deal creation ---
    // Every prospect who provides an email gets a Company + Deal at Lead stage.
    if (!dossier.contactEmail) {
      await recordDossierCrmDeal(dossier.id, "attio", recordId);
      log.info({ dossierId: dossier.id, recordId }, "Wrote Person to Attio (no email — skipping Deal)");
      return true;
    }

    // Close the MCP client used for Person creation; runAttioAgent creates its own.
    await client.close().catch(() => {});

    // Look up the Attio connector's email for deal ownership
    let attioOwnerEmail: string | null = null;
    try {
      const { data: attioCreds } = await supabase
        .from("attio_credentials")
        .select("connected_by_user_id")
        .eq("organization_id", dossier.organizationId)
        .eq("status", "active")
        .maybeSingle();
      if (attioCreds?.connected_by_user_id) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("email, display_name")
          .eq("user_id", attioCreds.connected_by_user_id)
          .maybeSingle();
        if (profile?.email) attioOwnerEmail = profile.email;
      }
    } catch (err) {
      log.warn({ err }, "Failed to look up Attio connector email for deal creation");
    }

    const attioUser: UserInfo = {
      name: null,
      email: attioOwnerEmail,
      company: orgName,
      title: null,
    };

    const companyName = dossier.contactCompany || "Unknown Company";
    const dealName = `${companyName} — Prospect Chat`;

    const researchLines: string[] = [];
    if (dossier.fitScore !== null) {
      researchLines.push(`**Fit Score:** ${dossier.fitScore}/100 (${dossier.fitBand ?? "—"})`);
    }
    if (dossier.strengths.length > 0) {
      researchLines.push(`\n**Strengths:**\n${dossier.strengths.map(s => `- ${s}`).join("\n")}`);
    }
    if (dossier.gaps.length > 0) {
      researchLines.push(`\n**Gaps:**\n${dossier.gaps.map(g => `- ${g}`).join("\n")}`);
    }
    if (dossier.currentState) {
      researchLines.push(`\n**Current State:**\n${dossier.currentState}`);
    }
    const researchNote = researchLines.join("\n");

    try {
      await Promise.race([
        runAttioAgent({
          query: `Search for an existing company "${companyName}" and person "${dossier.contactEmail}" in Attio.

If the company does NOT exist, create a new company record for "${companyName}".

Then search for any existing deals associated with the company "${companyName}" or contact "${dossier.contactEmail}".

If a deal ALREADY EXISTS: update its stage if appropriate and add a note with the research data below. Do NOT create a new deal.

If NO deal exists: create a new deal named "${dealName}" for ${companyName}. Stage: Lead.

In all cases, add a detailed note to the deal and company records with this research data:

${researchNote}`,
          organizationId: dossier.organizationId,
          user: attioUser,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Attio Company+Deal creation timed out")), 45_000),
        ),
      ]);
      log.info({ dossierId: dossier.id, companyName, dealName }, "Attio Company + Deal created via agent");
    } catch (err) {
      log.warn({ err, dossierId: dossier.id }, "Attio Company+Deal creation failed (non-fatal, Person was still created)");
    }

    // Build deep-link URL. Attio's record-detail route is:
    //   /<slug>/person/<record_id>/overview   (for Person)
    //   /<slug>/deal/<record_id>/overview     (for Deal, if created)
    //
    // Slug source preference: attio_credentials.workspace_slug (auto-captured
    // at OAuth time) → organizations.settings.attio_workspace_slug (legacy
    // back-compat for orgs that haven't re-OAuthed since the auto-capture
    // shipped). If neither is set, we skip the URL — the Slack post falls
    // back to no button rather than rendering a broken one.
    const settings = (orgRow?.settings ?? {}) as Record<string, unknown>;
    const slug =
      credsRow?.workspace_slug ??
      (typeof settings.attio_workspace_slug === "string"
        ? (settings.attio_workspace_slug as string)
        : null);
    // Deep-link to the Person (Deal deep-link would need the deal record_id
    // from runAttioAgent, which doesn't return it reliably).
    const url = slug
      ? `https://app.attio.com/${slug}/person/${recordId}/overview`
      : undefined;
    if (!slug) {
      log.info(
        { dossierId: dossier.id, organizationId: dossier.organizationId },
        "No workspace slug available (creds.workspace_slug + settings.attio_workspace_slug both unset) — skipping deep-link URL. Re-OAuth Attio to auto-populate.",
      );
    }

    await recordDossierCrmDeal(dossier.id, "attio", recordId, url, { attioWorkspaceId: credsWorkspaceId });
    log.info({ dossierId: dossier.id, recordId, hasUrl: !!url }, "Wrote prospect Person to Attio");

    return true;
  } catch (err) {
    log.error({ err, dossierId: dossier.id }, "Attio sync failed");
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

async function syncToSalesforce(dossier: ProspectDossier): Promise<boolean> {
  if (!dossier.contactEmail && !dossier.contactName) {
    log.info({ dossierId: dossier.id }, "Skipping SFDC sync — no contact name or email yet");
    return false;
  }

  try {
    const conn = await getSalesforceConnection(dossier.organizationId);

    // Fetch the org row + SFDC creds row in parallel. The org row gives the
    // display name for the dossier note attribution; the creds row gives the
    // salesforce_org_id we stamp on the dossier so a future SFDC org switch
    // can detect orphaned Leads.
    const supabase = getSupabaseAdmin();
    const [orgResult, credsResult] = await Promise.all([
      supabase
        .from("organizations")
        .select("name")
        .eq("id", dossier.organizationId)
        .maybeSingle(),
      supabase
        .from("salesforce_credentials")
        .select("salesforce_org_id")
        .eq("organization_id", dossier.organizationId)
        .maybeSingle(),
    ]);
    const orgName = (orgResult.data as { name?: string } | null)?.name ?? null;
    const sfOrgId = (credsResult.data as { salesforce_org_id?: string | null } | null)?.salesforce_org_id ?? null;

    const lastName = dossier.contactName?.split(" ").slice(-1)[0] || dossier.contactCompany || "Prospect";
    const firstName = dossier.contactName?.split(" ").slice(0, -1).join(" ") || undefined;

    const lead: Record<string, unknown> = {
      LastName: lastName,
      Company: dossier.contactCompany || "(unknown)",
      LeadSource: "Slack Sales Agent Chat",
      Description: dossierNotes(dossier, orgName).slice(0, 32000),
    };
    if (firstName) lead.FirstName = firstName;
    if (dossier.contactEmail) lead.Email = dossier.contactEmail;
    if (dossier.contactRole) lead.Title = dossier.contactRole;
    if (dossier.fitScore !== null) lead.Rating = dossier.fitBand === "high" ? "Hot" : dossier.fitBand === "medium" ? "Warm" : "Cold";

    // jsforce types are loose; cast through unknown.
    const sobject = conn.sobject("Lead") as unknown as {
      create: (rec: Record<string, unknown>) => Promise<{ success: boolean; id: string; errors?: unknown[] }>;
    };
    const created = await sobject.create(lead);

    if (!created.success) {
      log.error({ dossierId: dossier.id, errors: created.errors }, "SFDC Lead.create failed");
      return false;
    }

    const url = conn.instanceUrl ? `${conn.instanceUrl}/lightning/r/Lead/${created.id}/view` : undefined;
    await recordDossierCrmDeal(dossier.id, "salesforce", created.id, url, { salesforceOrgId: sfOrgId });
    log.info({ dossierId: dossier.id, leadId: created.id }, "Wrote prospect to Salesforce");
    return true;
  } catch (err) {
    log.error({ err, dossierId: dossier.id }, "Salesforce sync failed");
    return false;
  }
}

/**
 * Push the refined dossier (strengths, gaps, current state, fit score) to an
 * already-existing Attio Deal. Called from the refinement re-delivery path
 * so reps see the Sonnet-refined data on the CRM record, not the original
 * inline-Haiku snapshot.
 *
 * Best-effort: stage update + a fresh Sales Agent note. Skipped silently when the
 * dossier's recorded workspace doesn't match the currently-connected one
 * (orphaned deal in a stale workspace).
 */
async function pushRefinedDossierToAttio(dossier: ProspectDossier): Promise<void> {
  if (!dossier.crmDealId) return;

  // Workspace mismatch guard — deal lives in a workspace we can't reach.
  if (dossier.attioWorkspaceId) {
    const supabase = getSupabaseAdmin();
    const { data: creds } = await supabase
      .from("attio_credentials")
      .select("attio_workspace_id")
      .eq("organization_id", dossier.organizationId)
      .maybeSingle();
    const currentWorkspaceId = (creds as { attio_workspace_id?: string | null } | null)?.attio_workspace_id ?? null;
    if (currentWorkspaceId && currentWorkspaceId !== dossier.attioWorkspaceId) {
      log.info(
        { dossierId: dossier.id, recordedWorkspaceId: dossier.attioWorkspaceId, currentWorkspaceId },
        "Skipping refined Attio update — dossier's deal lives in a different workspace",
      );
      return;
    }
  }

  let client: Awaited<ReturnType<typeof getAttioClient>> = null;
  try {
    client = await getAttioClient(dossier.organizationId);
    if (!client) return;

    // Stage update — only if the dossier actually has a stage.
    if (dossier.conversationStage) {
      const newAttioStage = STAGE_TO_ATTIO[dossier.conversationStage];
      try {
        await client.callTool({
          name: "update-record",
          arguments: {
            object: "deals",
            record_id: dossier.crmDealId,
            values: { stage: [{ status: newAttioStage }] },
          },
        });
        log.info(
          { dossierId: dossier.id, dealId: dossier.crmDealId, newAttioStage, version: dossier.version },
          "Updated Attio Deal stage from refined dossier",
        );
      } catch (err) {
        log.warn({ err, dossierId: dossier.id }, "Attio Deal stage update failed (non-blocking)");
      }
    }

    // Fresh note — captures refined strengths/gaps/current_state so reps
    // looking at the Deal see the Sonnet-refined view, not the original.
    const supabase = getSupabaseAdmin();
    const { data: orgRow } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", dossier.organizationId)
      .maybeSingle();
    const orgName = (orgRow as { name?: string } | null)?.name ?? null;

    try {
      await client.callTool({
        name: "create-note",
        arguments: {
          title: `Sales Agent dossier — refined v${dossier.version}${dossier.contactName ? ` — ${dossier.contactName}` : ""}`,
          content: dossierNotes(dossier, orgName),
          parent_object: "deals",
          parent_record_id: dossier.crmDealId,
        },
      });
    } catch (err) {
      log.warn({ err, dossierId: dossier.id }, "Failed to attach refined Attio note (non-blocking)");
    }
  } catch (err) {
    log.warn({ err, dossierId: dossier.id }, "Refined Attio dossier update failed (non-blocking)");
  } finally {
    await client?.close().catch(() => {});
  }
}

/**
 * Push the refined dossier to an already-existing Salesforce Lead.
 * Updates Description (replaces with refined dossierNotes) and Rating from
 * the refined fit band.
 */
async function pushRefinedDossierToSalesforce(dossier: ProspectDossier): Promise<void> {
  if (!dossier.crmDealId) return;
  try {
    const conn = await getSalesforceConnection(dossier.organizationId);
    const supabase = getSupabaseAdmin();
    const { data: orgRow } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", dossier.organizationId)
      .maybeSingle();
    const orgName = (orgRow as { name?: string } | null)?.name ?? null;

    const updates: Record<string, unknown> = {
      Id: dossier.crmDealId,
      Description: dossierNotes(dossier, orgName).slice(0, 32000),
    };
    if (dossier.fitScore !== null) {
      updates.Rating = dossier.fitBand === "high" ? "Hot" : dossier.fitBand === "medium" ? "Warm" : "Cold";
    }

    const sobject = conn.sobject("Lead") as unknown as {
      update: (rec: Record<string, unknown>) => Promise<{ success: boolean; id: string; errors?: unknown[] }>;
    };
    const result = await sobject.update(updates);
    if (!result.success) {
      log.warn({ dossierId: dossier.id, errors: result.errors }, "Refined SFDC Lead update failed (non-blocking)");
      return;
    }
    log.info(
      { dossierId: dossier.id, leadId: dossier.crmDealId, version: dossier.version },
      "Updated Salesforce Lead from refined dossier",
    );
  } catch (err) {
    log.warn({ err, dossierId: dossier.id }, "Refined SFDC dossier update failed (non-blocking)");
  }
}

/**
 * Resolve the org's primary CRM for the prospect-dossier "Open in" record.
 *
 * Decision order:
 *   1. `organizations.settings.primary_crm` — admin-set preference. Honored
 *      strictly when the chosen CRM is connected.
 *   2. If the chosen CRM is set but NOT connected, fall back to the other
 *      CRM if it's connected (better to sync somewhere than nowhere) and
 *      log a warning.
 *   3. If the setting is unset, default to Attio when connected, then SFDC.
 *
 * Signal sync (separate flow in `crm-sync-signals.ts`) still writes to BOTH
 * connected CRMs in parallel — the primary picker only governs the dossier's
 * "Open in" record stamping, not signal updates.
 */
async function resolvePrimaryProvider(
  organizationId: string,
): Promise<"attio" | "salesforce" | null> {
  const supabase = getSupabaseAdmin();
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();

  const settings = (orgRow?.settings ?? {}) as Record<string, unknown>;
  const preference =
    settings.primary_crm === "attio" || settings.primary_crm === "salesforce"
      ? (settings.primary_crm as "attio" | "salesforce")
      : null;

  const [hasAttio, hasSfdc] = await Promise.all([
    hasAttioConnection(organizationId),
    isSalesforceConfiguredForOrg(organizationId),
  ]);

  if (preference === "attio") {
    if (hasAttio) return "attio";
    if (hasSfdc) {
      log.warn(
        { organizationId },
        "primary_crm=attio but Attio is not connected; falling back to Salesforce",
      );
      return "salesforce";
    }
    return null;
  }
  if (preference === "salesforce") {
    if (hasSfdc) return "salesforce";
    if (hasAttio) {
      log.warn(
        { organizationId },
        "primary_crm=salesforce but Salesforce is not connected; falling back to Attio",
      );
      return "attio";
    }
    return null;
  }

  // No explicit preference — default Attio-first.
  if (hasAttio) return "attio";
  if (hasSfdc) return "salesforce";
  return null;
}

/**
 * Main entry. Picks the connected CRM and writes a single record.
 *
 * Flow:
 *   1. If crmDealId already stamped → push refined fields to the existing
 *      record (stage, notes, fit). Idempotent enough for re-delivery.
 *   2. Otherwise, resolve the primary CRM (Attio > SFDC). Dedup is scoped
 *      to the primary so a stale SFDC Lead doesn't lock an Attio-primary
 *      org into the wrong CRM.
 *   3. Create a record on the primary.
 */
export async function syncDossierToCrm(dossier: ProspectDossier): Promise<void> {
  if (dossier.crmDealId) {
    if (dossier.crmProvider === "attio") {
      await pushRefinedDossierToAttio(dossier);
    } else if (dossier.crmProvider === "salesforce") {
      await pushRefinedDossierToSalesforce(dossier);
    } else {
      log.info(
        { dossierId: dossier.id, crmProvider: dossier.crmProvider, crmDealId: dossier.crmDealId },
        "Dossier already has a CRM record on an unsupported provider; skipping",
      );
    }
    return;
  }

  const primary = await resolvePrimaryProvider(dossier.organizationId);
  if (!primary) {
    log.info(
      { dossierId: dossier.id, organizationId: dossier.organizationId },
      "No connected CRM for prospect dossier — skipping",
    );
    return;
  }

  // --- Dedup: scoped to the primary CRM only. A SFDC record found while
  //     Attio is primary is ignored for stamping; we still create the Attio
  //     record so the "Open in" button points where it should.
  if (dossier.contactEmail) {
    const existing = await lookupExistingCrmRecord(
      dossier.organizationId,
      dossier.contactEmail,
      primary,
    );

    if (existing.existingDossierCrmId && existing.existingCrmProvider === primary) {
      log.info(
        { dossierId: dossier.id, existingCrmId: existing.existingDossierCrmId, provider: primary },
        "CRM record already exists on primary provider — stamping on current dossier",
      );
      await recordDossierCrmDeal(
        dossier.id,
        primary,
        existing.existingDossierCrmId,
        undefined,
        {
          attioWorkspaceId: existing.existingAttioWorkspaceId,
          salesforceOrgId: existing.existingSalesforceOrgId,
        },
      );
      return;
    }

    if (existing.existingContact) {
      log.info(
        { dossierId: dossier.id, existingContactId: existing.existingContact.id },
        "Existing contact found in contacts table — CRM provider may upsert",
      );
    }
  }

  if (primary === "attio") {
    if (await syncToAttio(dossier)) return;
    // Attio sync failed — fall back to SFDC if connected.
    if (await isSalesforceConfiguredForOrg(dossier.organizationId)) {
      if (await syncToSalesforce(dossier)) return;
    }
  } else {
    if (await syncToSalesforce(dossier)) return;
  }

  log.info(
    { dossierId: dossier.id, organizationId: dossier.organizationId, primary },
    "All CRM sync attempts failed — dossier remains unstamped",
  );
}
