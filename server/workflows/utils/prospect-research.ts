/**
 * Deep Prospect Research — Exa-powered company + person research.
 *
 * Enriches contacts with company info, person info, and recent news.
 * Results are persisted to the contact_enrichment table.
 */

import { getSupabaseAdmin } from "./supabase";
import { logger } from "../../lib/logger";

const log = logger.child({ util: "prospect-research" });

export interface ProspectResearchResult {
  company: {
    name: string;
    domain: string;
    description: string;
    industry: string | null;
    employeeRange: string | null;
    fundingStage: string | null;
    recentNews: Array<{ title: string; url: string; snippet: string }>;
  } | null;
  person: {
    name: string;
    title: string | null;
    headline: string | null;
    linkedinUrl: string | null;
    summary: string | null;
  } | null;
  raw: {
    companyResults: any[];
    personResults: any[];
    newsResults: any[];
  };
}

/**
 * Research a prospect using Exa — company homepage, person LinkedIn, recent news.
 */
export async function researchProspect(params: {
  senderEmail: string;
  senderName: string | null;
  senderDomain: string;
}): Promise<ProspectResearchResult> {
  const { senderEmail, senderName, senderDomain } = params;
  const exaApiKey = process.env.EXA_API_KEY;

  if (!exaApiKey) {
    return { company: null, person: null, raw: { companyResults: [], personResults: [], newsResults: [] } };
  }

  const { default: Exa } = await import("exa-js");
  const exa = new Exa(exaApiKey);

  // Run all three searches in parallel
  const [companyResults, personResults, newsResults] = await Promise.allSettled([
    // Company research — their website
    exa.searchAndContents(senderDomain, {
      type: "neural",
      numResults: 2,
      text: true,
      includeDomains: [senderDomain],
    }),

    // Person research — LinkedIn profile
    senderName
      ? exa.searchAndContents(`${senderName} ${senderDomain}`, {
          type: "neural",
          numResults: 2,
          text: true,
          includeDomains: ["linkedin.com"],
        })
      : Promise.resolve({ results: [] }),

    // Recent news about the company
    exa.searchAndContents(`${senderDomain} news`, {
      type: "neural",
      numResults: 3,
      text: true,
    }),
  ]);

  const companyData = companyResults.status === "fulfilled" ? companyResults.value.results || [] : [];
  const personData = personResults.status === "fulfilled" ? (personResults.value as any).results || [] : [];
  const newsData = newsResults.status === "fulfilled" ? newsResults.value.results || [] : [];

  // Parse company info
  let company: ProspectResearchResult["company"] = null;
  if (companyData.length > 0) {
    const r = companyData[0];
    const text = (r.text || "").substring(0, 2000);

    // Extract signals from text
    const industryMatch = text.match(/(?:industry|sector|space):\s*([^\n.]+)/i);
    const employeeMatch = text.match(/(\d[\d,]*)\s*(?:employees|team members|people)/i);
    const fundingMatch = text.match(/(?:Series\s+[A-Z]|seed|pre-seed|Series\s+\w+)/i);

    company = {
      name: r.title || senderDomain,
      domain: senderDomain,
      description: text.substring(0, 500),
      industry: industryMatch?.[1]?.trim() || null,
      employeeRange: employeeMatch ? categorizeEmployees(parseInt(employeeMatch[1].replace(/,/g, ""))) : null,
      fundingStage: fundingMatch?.[0] || null,
      recentNews: newsData.slice(0, 3).map((n: any) => ({
        title: n.title || "",
        url: n.url || "",
        snippet: (n.text || "").substring(0, 200),
      })),
    };
  }

  // Parse person info — filter out LinkedIn login/boilerplate text
  let person: ProspectResearchResult["person"] = null;
  if (personData.length > 0) {
    const r = personData[0];
    const rawText = (r.text || "");

    // Skip results that are just LinkedIn login pages
    const isBoilerplate = rawText.includes("By clicking Continue to join or sign in")
      || rawText.includes("User Agreement")
      || rawText.includes("Sign in to LinkedIn")
      || rawText.length < 50;

    if (!isBoilerplate) {
      const text = rawText.substring(0, 1000);

      // Extract title/headline from LinkedIn text
      const titleMatch = text.match(/(?:^|\n)([^\n]+(?:VP|Director|Manager|Head|Chief|CEO|CTO|CFO|COO|Founder|Engineer|Developer|President|Partner|Principal|Consultant|Advisor|Sales|Marketing|Revenue|Growth|Account)[^\n]*)/i);

      // Find a meaningful headline line (skip short or boilerplate lines)
      const headline = text.split("\n").find((l: string) =>
        l.length > 20 && l.length < 200
        && !l.includes("LinkedIn")
        && !l.includes("cookie")
        && !l.includes("Sign in")
      ) || null;

      person = {
        name: senderName || "",
        title: titleMatch?.[1]?.trim() || null,
        headline,
        linkedinUrl: r.url?.includes("linkedin.com") ? r.url : null,
        summary: text.substring(0, 300),
      };
    } else {
      // Boilerplate — try the second result if available
      const fallback = personData[1];
      if (fallback && !(fallback.text || "").includes("By clicking Continue")) {
        const text = (fallback.text || "").substring(0, 1000);
        const titleMatch = text.match(/(?:^|\n)([^\n]+(?:VP|Director|Manager|Head|Chief|CEO|CTO|CFO|COO|Founder|Engineer|Developer|President|Partner|Sales|Marketing|Revenue|Growth)[^\n]*)/i);

        person = {
          name: senderName || "",
          title: titleMatch?.[1]?.trim() || null,
          headline: text.split("\n").find((l: string) => l.length > 20 && l.length < 200) || null,
          linkedinUrl: fallback.url?.includes("linkedin.com") ? fallback.url : null,
          summary: text.substring(0, 300),
        };
      } else {
        // Both results are boilerplate — just record the LinkedIn URL if we have it
        person = {
          name: senderName || "",
          title: null,
          headline: null,
          linkedinUrl: r.url?.includes("linkedin.com") ? r.url : null,
          summary: null,
        };
      }
    }
  }

  return {
    company,
    person,
    raw: {
      companyResults: companyData,
      personResults: personData,
      newsResults: newsData,
    },
  };
}

/**
 * Persist research results to contact_enrichment table.
 */
export async function persistProspectResearch(params: {
  contactId: string;
  research: ProspectResearchResult;
}): Promise<void> {
  const { contactId, research } = params;
  const supabase = getSupabaseAdmin();

  const updateData: Record<string, any> = {
    web_research_last_updated: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (research.company) {
    updateData.company_industry = research.company.industry;
    updateData.company_size_range = research.company.employeeRange;
    updateData.company_recent_news = research.company.recentNews;
    updateData.web_research_summary = research.company.description;
    updateData.web_research_sources = research.raw.companyResults.map((r: any) => ({
      title: r.title,
      url: r.url,
    }));
  }

  if (research.person) {
    updateData.linkedin_headline = research.person.headline;
    updateData.linkedin_summary = research.person.summary;
  }

  // Upsert — create if doesn't exist
  const { error } = await supabase
    .from("contact_enrichment")
    .upsert(
      { contact_id: contactId, ...updateData },
      { onConflict: "contact_id" },
    );

  if (error) {
    log.error({ err: error }, "Failed to persist research results");
  }
}

function categorizeEmployees(count: number): string {
  if (count <= 10) return "1-10";
  if (count <= 50) return "11-50";
  if (count <= 200) return "51-200";
  if (count <= 1000) return "201-1000";
  if (count <= 5000) return "1001-5000";
  return "5000+";
}
