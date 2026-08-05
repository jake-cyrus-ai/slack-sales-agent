/**
 * Fit Score & Dossier Generator
 *
 * Uses Claude to score prospect fit (0-100) against the org's ICP
 * and builds a structured dossier for downstream email generation.
 *
 * ICP source priority:
 *   1. Playbooks (free-form text, org's source of truth when present)
 *   2. Structured orgContext fields (icp_industries, icp_company_sizes, etc.)
 */

import { generateClaudeMessage, parseJSONResponse } from "./llm/clients";
import { logger } from "../../lib/logger";

const log = logger.child({ util: "fit-score-dossier" });

export interface FitScoreResult {
  fitScore: number; // 0-100
  fitLevel: "high" | "medium" | "low";
  strengths: string[];
  gaps: string[];
  dossier: string; // markdown summary for Slack/prompt injection
  strategicGuidance: string; // guidance for the email response
}

export async function scoreFitAndBuildDossier(params: {
  orgContext: {
    product_name: string | null;
    product_description: string | null;
    icp_industries: any;
    icp_company_sizes: any;
    icp_titles: any;
    icp_pain_points: any;
    icp_description: string | null;
    competitors: any;
    competitive_advantages: any;
  } | null;
  playbooks?: Array<{ name: string; content: string }>;
  prospectResearch: {
    company: {
      name: string;
      domain: string;
      description: string;
      industry: string | null;
      employeeRange: string | null;
      fundingStage: string | null;
    } | null;
    person: {
      name: string;
      title: string | null;
      headline: string | null;
    } | null;
  };
  senderEmail: string;
  senderName: string | null;
  emailSubject: string;
  emailBody: string;
}): Promise<FitScoreResult> {
  const { orgContext, playbooks, prospectResearch, senderEmail, senderName, emailSubject, emailBody } = params;

  // No org context and no playbooks — return a neutral default
  if (!orgContext && (!playbooks || playbooks.length === 0)) {
    const gaps = ["No ICP data configured to evaluate fit"];
    return {
      fitScore: 50,
      fitLevel: "medium",
      strengths: ["Prospect reached out proactively"],
      gaps,
      dossier: buildDossier({
        prospectResearch,
        senderEmail,
        senderName,
        fitScore: 50,
        fitLevel: "medium",
        strengths: ["Prospect reached out proactively"],
        gaps,
      }),
      strategicGuidance:
        "No ICP data is configured. Respond helpfully, ask qualifying questions to understand their needs, and gather information about their company size, industry, and use case.",
    };
  }

  // ── Build the scoring prompt ──────────────────────────────────────────
  // Playbooks take priority over structured fields for the ICP block
  const hasPlaybooks = playbooks && playbooks.length > 0;

  let icpBlock: string;
  let productBlock: string;

  if (hasPlaybooks) {
    // Playbooks are the source of truth — they contain ICP, product info, and strategy
    icpBlock = `## Organization Playbooks (source of truth for ICP and sales strategy)\n${playbooks.map(p => `### ${p.name}\n${p.content}`).join("\n\n")}`;
    // Still include product info from orgContext if available
    productBlock = orgContext
      ? [
          orgContext.product_name && `Product: ${orgContext.product_name}`,
          orgContext.product_description && `Description: ${orgContext.product_description}`,
        ]
          .filter(Boolean)
          .join("\n")
      : "";
  } else {
    // Fall back to structured orgContext fields (backward compatible)
    icpBlock = orgContext
      ? [
          orgContext.icp_description && `ICP Description: ${orgContext.icp_description}`,
          orgContext.icp_industries && `Target Industries: ${JSON.stringify(orgContext.icp_industries)}`,
          orgContext.icp_company_sizes && `Target Company Sizes (soft preference, not a hard filter): ${JSON.stringify(orgContext.icp_company_sizes)}`,
          orgContext.icp_titles && `Target Titles: ${JSON.stringify(orgContext.icp_titles)}`,
          orgContext.icp_pain_points && `Pain Points We Solve: ${JSON.stringify(orgContext.icp_pain_points)}`,
          orgContext.competitors && `Known Competitors: ${JSON.stringify(orgContext.competitors)}`,
          orgContext.competitive_advantages &&
            `Our Advantages: ${JSON.stringify(orgContext.competitive_advantages)}`,
        ]
          .filter(Boolean)
          .join("\n")
      : "";

    productBlock = orgContext
      ? [
          orgContext.product_name && `Product: ${orgContext.product_name}`,
          orgContext.product_description && `Description: ${orgContext.product_description}`,
        ]
          .filter(Boolean)
          .join("\n")
      : "";
  }

  // Defensive: prospect chat captures `company` and `name` from a free-form
  // intake form, so we get garbage like "/" or empty strings when prospects
  // don't fill the field. If we pass that through, Exa enrichment fills the
  // industry/employee-range fields with generic placeholders, and the scorer
  // LLM happily concatenates "/" + "(Technology, Information and Internet ·
  // 1-10)" into a "strength". Strip meaningless inputs before they pollute
  // the dossier — the scorer should see "limited information" and produce a
  // low fit, not invent strengths from junk.
  const isMeaningful = (s: string | null | undefined): s is string =>
    !!s && s.trim().length >= 3 && !/^[/\-_.\s]+$/.test(s.trim());

  const cleanCompany = isMeaningful(prospectResearch.company?.name)
    ? prospectResearch.company
    : null;
  const cleanPerson = isMeaningful(prospectResearch.person?.name)
    ? prospectResearch.person
    : null;
  const cleanSenderName = isMeaningful(senderName) ? senderName : null;

  const prospectBlock = [
    cleanCompany && `Company: ${cleanCompany.name} (${cleanCompany.domain})`,
    cleanCompany?.description && `Company Description: ${cleanCompany.description}`,
    // Only include industry/size/funding when we have a real company name —
    // otherwise these are enrichment placeholders not anchored to anything.
    cleanCompany && prospectResearch.company?.industry && `Industry: ${prospectResearch.company.industry}`,
    cleanCompany && prospectResearch.company?.employeeRange &&
      `Employee Range: ${prospectResearch.company.employeeRange}`,
    cleanCompany && prospectResearch.company?.fundingStage &&
      `Funding Stage: ${prospectResearch.company.fundingStage}`,
    cleanPerson &&
      `Contact: ${cleanPerson.name}${cleanPerson.title ? ` — ${cleanPerson.title}` : ""}`,
    cleanPerson?.headline && `Headline: ${cleanPerson.headline}`,
    `Email: ${senderEmail}`,
    cleanSenderName && `Sender Name: ${cleanSenderName}`,
  ]
    .filter(Boolean)
    .join("\n");

  const playbookInstruction = hasPlaybooks
    ? "\n\nThe ICP criteria are embedded in the playbook text below. Extract the relevant ICP dimensions (target industries, company sizes, buyer personas, pain points, etc.) from the playbook content and score the prospect against them."
    : "";

  const systemPrompt = `You are a sales intelligence analyst. Given a company's Ideal Customer Profile (ICP) and information about an inbound prospect, score how well the prospect fits the ICP on a 0-100 scale and provide structured reasoning.${playbookInstruction}

Respond with ONLY valid JSON in this exact format:
{
  "fitScore": <number 0-100>,
  "strengths": ["strength 1", "strength 2"],
  "gaps": ["gap 1", "gap 2"]
}

Scoring guidelines:
- 80-100: Strong ICP match — right industry, company size, title, and clear pain point alignment
- 60-79: Good potential — matches on several ICP dimensions but missing some signals
- 40-59: Unclear fit — limited data or partial match; needs qualification
- 20-39: Weak fit — mismatches on key ICP dimensions
- 0-19: Poor fit — clearly outside ICP on most dimensions`;

  const userPrompt = `## Our Product
${productBlock || "No product info available."}

## Our Ideal Customer Profile
${icpBlock || "No ICP data available."}

## Prospect Information
${prospectBlock}

## Their Email
Subject: ${emailSubject}
Body:
${emailBody.slice(0, 2000)}

Score this prospect's fit against our ICP. Be specific about what matches and what doesn't.`;

  // ── Call Claude ────────────────────────────────────────────────────────
  let fitScore = 50;
  let strengths: string[] = [];
  let gaps: string[] = [];

  try {
    const response = await generateClaudeMessage(
      [{ role: "user", content: userPrompt }],
      {
        model: "claude-sonnet-4-20250514",
        system: systemPrompt,
        maxTokens: 1500,
        temperature: 0.3,
      }
    );

    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = parseJSONResponse<{
      fitScore: number;
      strengths: string[];
      gaps?: string[];
      weaknesses?: string[]; // backward compat: LLM may still return this key
    }>(text);

    fitScore = Math.max(0, Math.min(100, Math.round(parsed.fitScore)));
    strengths = parsed.strengths ?? [];
    // Accept either `gaps` or `weaknesses` from LLM output
    gaps = parsed.gaps ?? parsed.weaknesses ?? [];
  } catch (err) {
    log.error({ err }, "LLM scoring failed, using defaults");
    strengths = ["Prospect reached out proactively"];
    gaps = ["Automated scoring failed — review manually"];
  }

  // ── Derive fit level ──────────────────────────────────────────────────
  const fitLevel: FitScoreResult["fitLevel"] =
    fitScore >= 70 ? "high" : fitScore >= 40 ? "medium" : "low";

  // ── Strategic guidance ────────────────────────────────────────────────
  const strategicGuidance = buildStrategicGuidance(fitLevel, strengths, gaps);

  // ── Dossier ───────────────────────────────────────────────────────────
  const dossier = buildDossier({
    prospectResearch,
    senderEmail,
    senderName,
    fitScore,
    fitLevel,
    strengths,
    gaps,
  });

  return { fitScore, fitLevel, strengths, gaps, dossier, strategicGuidance };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildDossier(params: {
  prospectResearch: {
    company: { name: string; domain: string; description: string; industry: string | null; employeeRange: string | null; fundingStage: string | null } | null;
    person: { name: string; title: string | null; headline: string | null } | null;
  };
  senderEmail: string;
  senderName: string | null;
  fitScore: number;
  fitLevel: string;
  strengths: string[];
  gaps: string[];
}): string {
  const { prospectResearch, senderEmail, senderName, fitScore, fitLevel, strengths, gaps } =
    params;
  const lines: string[] = [];

  lines.push("## Prospect Dossier");
  lines.push("");

  // Contact
  const contactName = prospectResearch.person?.name ?? senderName ?? senderEmail;
  lines.push(`**Contact:** ${contactName} (${senderEmail})`);
  if (prospectResearch.person?.title) {
    lines.push(`**Title:** ${prospectResearch.person.title}`);
  }
  if (prospectResearch.person?.headline) {
    lines.push(`**Headline:** ${prospectResearch.person.headline}`);
  }
  lines.push("");

  // Company
  if (prospectResearch.company) {
    const c = prospectResearch.company;
    lines.push(`**Company:** ${c.name} (${c.domain})`);
    if (c.description) lines.push(`**About:** ${c.description}`);
    if (c.industry) lines.push(`**Industry:** ${c.industry}`);
    if (c.employeeRange) lines.push(`**Size:** ${c.employeeRange}`);
    if (c.fundingStage) lines.push(`**Funding:** ${c.fundingStage}`);
    lines.push("");
  }

  // Fit
  lines.push(`**Fit Score:** ${fitScore}/100 (${fitLevel})`);
  if (strengths.length) {
    lines.push("**Strengths:**");
    strengths.forEach((s) => lines.push(`- ${s}`));
  }
  if (gaps.length) {
    lines.push("**Gaps:**");
    gaps.forEach((g) => lines.push(`- ${g}`));
  }

  return lines.join("\n");
}

function buildStrategicGuidance(
  fitLevel: FitScoreResult["fitLevel"],
  strengths: string[],
  gaps: string[]
): string {
  switch (fitLevel) {
    case "high":
      return [
        "HIGH-FIT PROSPECT — be enthusiastic and proactive.",
        "Acknowledge their specific pain points and show how we solve them.",
        "Offer a concrete next step (demo, call, trial) right away.",
        strengths.length ? `Leverage these strengths: ${strengths.join("; ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");

    case "medium":
      return [
        "MEDIUM-FIT PROSPECT — be helpful but qualify further.",
        "Ask questions to understand their specific needs, timeline, and budget.",
        "Share relevant value without over-committing.",
        gaps.length
          ? `Probe around these gaps: ${gaps.join("; ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");

    case "low":
      return [
        "LOW-FIT PROSPECT — be polite and helpful but don't oversell.",
        "Be transparent about potential mismatches.",
        "If there's a better-fitting solution or approach, suggest it.",
        "Keep the door open but don't push aggressively for a meeting.",
      ].join(" ");
  }
}
