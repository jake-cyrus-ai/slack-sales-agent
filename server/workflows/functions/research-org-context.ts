/**
 * Research Org Context — Vercel Workflow Function
 *
 * Fetches and persists organization context (product, ICP, competitors)
 * using Exa research + LLM synthesis. Called once per org, cached in org_context table.
 */

import { logger } from "../../lib/logger";
import { workflow } from "../client";
import { getSupabaseAdmin } from "../utils";
import { generateClaudeMessage, parseJSONResponse } from "../utils/llm/clients";
import { browseAndExtract, browseMultiple } from "../../src/lib/browserbase";

const log = logger.child({ fn: "research-org-context" });

export const researchOrgContext = workflow.createFunction(
  {
    id: "research-org-context",
    retries: 2,
    concurrency: [{ limit: 3, scope: "fn" }],
  },
  { event: "org/research-context" },
  async ({ event, step }) => {
        const { organizationId } = event.data;

    // Step 1: Check if we already have recent context
    const existing = await step.run("check-existing", async () => {
            const supabase = getSupabaseAdmin();
      const { data } = await supabase
        .from("org_context")
        .select("*")
        .eq("organization_id", organizationId)
        .maybeSingle();

      if (data?.research_status === "complete" && data.last_researched_at) {
        const lastResearched = new Date(data.last_researched_at);
        const daysSince = (Date.now() - lastResearched.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince < 7) {
          return { skip: true, context: data };
        }
      }

      return { skip: false, context: data };
    });

    if (existing.skip) {
      return { status: "cached", context: existing.context };
    }

    // Step 2: Get org info (name + owner's company/email domain as proxy)
    const orgInfo = await step.run("get-org-info", async () => {
            const supabase = getSupabaseAdmin();
      const { data: org } = await supabase
        .from("organizations")
        .select("id, name, slug, owner_user_id")
        .eq("id", organizationId)
        .single();

      if (!org) {
        log.warn({ organizationId }, "Organization not found");
        return null;
      }

      // Try to infer domain from owner's profile
      let domain: string | null = null;
      if (org.owner_user_id) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("email, company")
          .eq("user_id", org.owner_user_id)
          .maybeSingle();

        if (profile?.email) {
          domain = profile.email.split("@")[1];
          // Skip generic email domains
          const genericDomains = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"];
          if (genericDomains.includes(domain)) domain = null;
        }
      }

      return { id: org.id, name: org.name, domain, website: domain ? `https://${domain}` : null };
    });

    if (!orgInfo) {
      return { status: "skipped", reason: "Organization not found" };
    }

    // Step 3: Mark as researching
    await step.run("mark-researching", async () => {
            const supabase = getSupabaseAdmin();
      await supabase
        .from("org_context")
        .upsert(
          {
            organization_id: organizationId,
            research_status: "researching",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "organization_id" },
        );
    });

    // Step 4: Exa research — product, competitors
    const researchResults = await step.run("exa-research", async () => {
            const exaApiKey = process.env.EXA_API_KEY;
      if (!exaApiKey) return { productResults: [], competitorResults: [] };

      const { default: Exa } = await import("exa-js");
      const exa = new Exa(exaApiKey);
      const domain = orgInfo.domain || orgInfo.website?.replace(/^https?:\/\//, "").split("/")[0];

      if (!domain) return { productResults: [], competitorResults: [] };

      const [productRes, competitorRes] = await Promise.allSettled([
        exa.searchAndContents(domain, {
          type: "neural",
          numResults: 3,
          text: true,
          includeDomains: [domain],
        }),
        exa.searchAndContents(`${orgInfo.name || domain} competitors alternatives`, {
          type: "neural",
          numResults: 5,
          text: true,
        }),
      ]);

      return {
        productResults: productRes.status === "fulfilled" ? productRes.value.results || [] : [],
        competitorResults: competitorRes.status === "fulfilled" ? competitorRes.value.results || [] : [],
      };
    });

    // Step 4b: visit public org and competitor pages for live context
    const browseResults = await step.run("public-web-research", async () => {
      // Browse the org's own website for accurate product info
      const orgPage = orgInfo.website ? await browseAndExtract(orgInfo.website) : null;

      // Extract competitor URLs from Exa results and browse their homepages
      const competitorUrls = researchResults.competitorResults
        .map((r: any) => {
          try {
            const u = new URL(r.url);
            return `${u.protocol}//${u.hostname}`;
          } catch { return null; }
        })
        .filter((u: string | null): u is string => !!u)
        .filter((u: string, i: number, arr: string[]) => arr.indexOf(u) === i)
        .slice(0, 3);

      const competitorPages = competitorUrls.length > 0
        ? await browseMultiple(competitorUrls)
        : [];

      return { orgPage, competitorPages };
    });

    // Step 5: LLM synthesis — extract structured context
    const synthesized = await step.run("synthesize-context", async () => {
            const productText = researchResults.productResults
        .map((r: any) => `# ${r.title}\n${(r.text || "").substring(0, 1500)}`)
        .join("\n\n");

      // Supplement Exa competitor text with current public-page extractions
      const exaCompetitorText = researchResults.competitorResults
        .map((r: any) => `# ${r.title}\n${(r.text || "").substring(0, 500)}`)
        .join("\n\n");

      const browserbaseCompetitorText = browseResults.competitorPages
        .filter((p) => !p.error && p.text)
        .map((p) => `# ${p.title} (${p.url})\n${p.text.substring(0, 1500)}`)
        .join("\n\n");

      const browserbaseOrgText = browseResults.orgPage && !browseResults.orgPage.error
        ? `\n\nLIVE WEBSITE CONTENT (${orgInfo.website}):\n${browseResults.orgPage.text.substring(0, 2000)}`
        : "";

      const competitorText = [exaCompetitorText, browserbaseCompetitorText]
        .filter(Boolean)
        .join("\n\n");

      const prompt = `Analyze the following web research about "${orgInfo.name}" and extract structured business context.

PRODUCT PAGES:
${productText || "No product pages found."}${browserbaseOrgText}

COMPETITOR/ALTERNATIVE PAGES:
${competitorText || "No competitor info found."}

IMPORTANT:
- For icp_company_sizes, use general size labels like "startup", "mid-market", "enterprise", "SMB". NEVER include specific revenue or ARR figures (e.g. "$20M-$200M ARR").
- For icp_description, describe the ideal customer in terms of industry, role, and pain points — not revenue ranges.
- Company size is a soft preference, not a hard filter. The agent should be open to prospects outside the typical size range.

Return JSON only:
{
  "product_name": "the product name",
  "product_description": "1-2 sentence description of what the product does",
  "product_features": ["feature1", "feature2", ...],
  "product_pricing_summary": "brief pricing summary if found, or null",
  "product_use_cases": ["use case 1", "use case 2", ...],
  "icp_industries": ["industry1", "industry2"],
  "icp_company_sizes": ["startup", "mid-market", "enterprise"],
  "icp_titles": ["VP Engineering", "CTO", ...],
  "icp_pain_points": ["pain point 1", "pain point 2"],
  "icp_description": "1-2 sentence ICP summary (no revenue/ARR figures)",
  "competitors": [{"name": "Competitor", "differentiator": "how we differ"}],
  "competitive_advantages": ["advantage 1", "advantage 2"]
}`;

      const response = await generateClaudeMessage(
        [{ role: "user", content: prompt }],
        { model: "claude-sonnet-4-20250514", temperature: 0.3, maxTokens: 2000 },
      );

      const content = response.content[0];
      if (content.type !== "text") throw new Error("Expected text response");

      return parseJSONResponse<{
        product_name: string;
        product_description: string;
        product_features: string[];
        product_pricing_summary: string | null;
        product_use_cases: string[];
        icp_industries: string[];
        icp_company_sizes: string[];
        icp_titles: string[];
        icp_pain_points: string[];
        icp_description: string;
        competitors: Array<{ name: string; differentiator: string }>;
        competitive_advantages: string[];
      }>(content.text);
    });

    // Step 6: Persist to org_context
    await step.run("persist-context", async () => {
            const supabase = getSupabaseAdmin();
      await supabase
        .from("org_context")
        .upsert(
          {
            organization_id: organizationId,
            product_name: synthesized.product_name,
            product_description: synthesized.product_description,
            product_features: synthesized.product_features,
            product_pricing_summary: synthesized.product_pricing_summary,
            product_use_cases: synthesized.product_use_cases,
            icp_industries: synthesized.icp_industries,
            icp_company_sizes: synthesized.icp_company_sizes,
            icp_titles: synthesized.icp_titles,
            icp_pain_points: synthesized.icp_pain_points,
            icp_description: synthesized.icp_description,
            competitors: synthesized.competitors,
            competitive_advantages: synthesized.competitive_advantages,
            research_sources: researchResults.productResults.map((r: any) => ({
              title: r.title,
              url: r.url,
            })),
            last_researched_at: new Date().toISOString(),
            research_status: "complete",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "organization_id" },
        );
    });

    return { status: "complete", synthesized };
  },
);
