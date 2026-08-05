/**
 * Document Categorization Utilities
 *
 * Ported from supabase/functions/initialize-knowledge-base/index.ts
 * Provides filename-based auto-categorization for uploaded documents.
 */

export const DOC_TYPE_LABELS: Record<string, string> = {
  "soc2": "SOC2",
  "pen-test": "Pen Test",
  "msa": "MSA",
  "terms": "Terms",
  "privacy": "Privacy",
  "datasheet": "Datasheet",
  "case-study": "Case Study",
  "comparison": "Comparison",
  "presentation": "Presentation",
  "one-pager": "One Pager",
  "other": "Other",
};

export function categorizeDocument(filename: string): string {
  const lowerName = filename.toLowerCase();

  // Agent playbook — operational instructions for the autonomous agent
  if (
    lowerName.includes("agent-playbook") ||
    lowerName.includes("agent_playbook") ||
    (lowerName.includes("agent") && lowerName.includes("playbook")) ||
    lowerName.includes("icp-playbook") ||
    lowerName.includes("renewal-playbook") ||
    lowerName.includes("objection-playbook") ||
    lowerName.includes("legal-playbook")
  ) {
    return "agent-playbook";
  }

  if (
    lowerName.includes("meddic") ||
    lowerName.includes("spin") ||
    lowerName.includes("sandler") ||
    lowerName.includes("challenger") ||
    lowerName.includes("methodology") ||
    lowerName.includes("framework")
  ) {
    return "sales-methodology";
  }

  if (
    lowerName.includes("playbook") ||
    lowerName.includes("cold") ||
    lowerName.includes("outreach") ||
    lowerName.includes("template") ||
    lowerName.includes("script")
  ) {
    return "playbook";
  }

  if (
    lowerName.includes("product") ||
    lowerName.includes("feature") ||
    lowerName.includes("pricing") ||
    lowerName.includes("roadmap") ||
    lowerName.includes("overview")
  ) {
    return "product-info";
  }

  if (
    lowerName.includes("competitive") ||
    lowerName.includes("competitor") ||
    lowerName.includes("battlecard") ||
    lowerName.includes("comparison")
  ) {
    return "competitive-intel";
  }

  if (
    lowerName.includes("industry") ||
    lowerName.includes("vertical") ||
    lowerName.includes("market") ||
    lowerName.includes("trend")
  ) {
    return "industry-knowledge";
  }

  if (lowerName.includes("memo") || lowerName.includes("customer"))
    return "customer-memo";
  if (lowerName.includes("nda") || lowerName.includes("agreement"))
    return "legal";
  if (lowerName.includes("test") || lowerName.includes("security"))
    return "security";
  if (lowerName.includes("sow") || lowerName.includes("statement"))
    return "contract";

  return "other";
}

export function getSubcategory(
  filename: string,
  category: string
): string | null {
  const lowerName = filename.toLowerCase();

  if (category === "agent-playbook") {
    if (lowerName.includes("sales")) return "sales";
    if (lowerName.includes("legal")) return "legal";
    if (lowerName.includes("icp")) return "icp";
    if (lowerName.includes("renewal")) return "renewal";
    if (lowerName.includes("objection")) return "objection-handling";
  }

  if (category === "playbook") {
    if (lowerName.includes("cold") || lowerName.includes("outreach"))
      return "cold-outreach";
    if (lowerName.includes("email")) return "email-templates";
    if (lowerName.includes("call") || lowerName.includes("phone"))
      return "cold-calling";
    if (lowerName.includes("demo")) return "demo-presentation";
    if (lowerName.includes("discovery")) return "discovery";
    if (lowerName.includes("negotiation")) return "negotiation";
    if (lowerName.includes("objection")) return "objection-handling";
    if (lowerName.includes("enterprise")) return "enterprise-sales";
    if (lowerName.includes("smb") || lowerName.includes("small"))
      return "smb-sales";
  }

  if (category === "product-info") {
    if (lowerName.includes("pricing")) return "pricing";
    if (lowerName.includes("feature")) return "features";
    if (lowerName.includes("roadmap")) return "roadmap";
    if (lowerName.includes("overview")) return "overview";
  }

  if (category === "competitive-intel") {
    if (lowerName.includes("battlecard")) return "battlecards";
    if (lowerName.includes("comparison")) return "comparisons";
  }

  if (category === "industry-knowledge") {
    if (lowerName.includes("healthcare")) return "healthcare";
    if (lowerName.includes("finance") || lowerName.includes("fintech"))
      return "finance";
    if (lowerName.includes("saas")) return "saas";
    if (lowerName.includes("retail")) return "retail";
  }

  return null;
}

export function determinePriority(filename: string, category: string): string {
  const lowerName = filename.toLowerCase();

  if (category === "agent-playbook") return "high";
  if (category === "sales-methodology") return "high";
  if (
    category === "playbook" &&
    (lowerName.includes("cold") ||
      lowerName.includes("discovery") ||
      lowerName.includes("demo"))
  ) {
    return "high";
  }

  if (
    category === "product-info" &&
    (lowerName.includes("pricing") || lowerName.includes("overview"))
  ) {
    return "high";
  }

  if (category === "competitive-intel" && lowerName.includes("battlecard")) {
    return "high";
  }

  if (lowerName.includes("2023") || lowerName.includes("2022")) return "low";

  return "medium";
}
