/**
 * Style examples API – submit example emails and derive writing_style_profile.
 */

import { Router, Response } from "express";
import { getAuth, requireAuth } from "../lib/auth";

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import type { Request } from "../types";

const MIN_EMAILS = 3;
const MAX_EMAILS = 20;
const MAX_BODY_LENGTH = 50000;

/** Words per sentence buckets (average across all emails) */
const WPS_SHORT = 12;
const WPS_LONG = 18;

/** Extract only what is directly observable from email bodies. No LLM. */
function observedFromBodies(
  bodies: { body: string }[]
): {
  sentence_length: string | null;
  typical_openings: string[];
  typical_sign_offs: string[];
  vocabulary_tendencies: string[];
} {
  const openings: string[] = [];
  const signOffs: string[] = [];
  let totalWords = 0;
  let totalSentences = 0;
  let contractionCount = 0;

  for (const { body } of bodies) {
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const firstLine = lines[0];
    if (firstLine.length <= 120) openings.push(firstLine);

    const lastLine = lines[lines.length - 1];
    if (lastLine.length <= 80) signOffs.push(lastLine);

    const text = body.replace(/\s+/g, " ").trim();
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    for (const s of sentences) {
      const words = s.trim().split(/\s+/).filter(Boolean);
      totalWords += words.length;
      totalSentences += 1;
    }
    if (/\b(I'm|we're|don't|can't|it's|that's|won't|wouldn't|isn't|aren't|wasn't|weren't|haven't|hasn't|we'll|I'll|they're|you're|there's|here's)\b/i.test(body)) {
      contractionCount += 1;
    }
  }

  const avgWps = totalSentences > 0 ? totalWords / totalSentences : 0;
  let sentence_length: string | null = null;
  if (totalSentences > 0) {
    if (avgWps <= WPS_SHORT) sentence_length = "short";
    else if (avgWps <= WPS_LONG) sentence_length = "medium";
    else sentence_length = "long";
  }

  const vocabulary_tendencies: string[] = [];
  if (contractionCount >= Math.min(2, bodies.length)) vocabulary_tendencies.push("uses contractions");

  const unique = (arr: string[]) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
  return {
    sentence_length,
    typical_openings: unique(openings).slice(0, 5),
    typical_sign_offs: unique(signOffs).slice(0, 5),
    vocabulary_tendencies,
  };
}

/** Remove placeholder-like content; trim. */
function sanitizeProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: 1 };
  for (const [k, v] of Object.entries(profile)) {
    if (k === "version") continue;
    if (v == null) continue;
    if (Array.isArray(v)) {
      const arr = v.map((x) => (typeof x === "string" ? x.replace(/^e\.g\.\s*/i, "").trim() : x)).filter((x) => x !== "");
      if (arr.length > 0) out[k] = arr;
    } else if (typeof v === "string") {
      const s = v.replace(/^e\.g\.\s*/i, "").trim();
      if (s && !/^e\.g\./i.test(s)) out[k] = s;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

const router = Router();

router.post("/style-examples", requireAuth(), async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized - No user ID in session" });
    }
    const user = { id: userId };

    const emails = req.body?.emails;
    if (!Array.isArray(emails)) {
      return res.status(400).json({ error: "emails must be an array" });
    }
    if (emails.length < MIN_EMAILS) {
      return res.status(400).json({ error: `Add at least ${MIN_EMAILS} emails.` });
    }
    if (emails.length > MAX_EMAILS) {
      return res.status(400).json({ error: `Use at most ${MAX_EMAILS} emails.` });
    }
    for (let i = 0; i < emails.length; i++) {
      const e = emails[i];
      if (typeof e?.body !== "string" || !e.body.trim()) {
        return res.status(400).json({ error: `Email ${i + 1} must have a non-empty body.` });
      }
      if (e.body.length > MAX_BODY_LENGTH) {
        return res.status(400).json({ error: `Email ${i + 1} body is too long.` });
      }
    }

    const supabase = getSupabaseAdmin();

    await supabase.from("user_email_style_examples").delete().eq("user_id", user.id);

    const rows = emails.map((e: { subject?: string; body: string }) => ({
      user_id: user.id,
      subject: typeof e.subject === "string" ? e.subject : null,
      body: e.body.trim(),
    }));
    const { error: insertError } = await supabase.from("user_email_style_examples").insert(rows);
    if (insertError) {
      req.log.error({ err: insertError }, "Insert error");
      return res.status(500).json({ error: "Failed to save examples." });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(503).json({ error: "Style analysis is not configured." });
    }

    const observed = observedFromBodies(rows);

    const sampleText = rows
      .map((r: { body: string }, i: number) => `--- Email ${i + 1} ---\n${r.body.substring(0, 2000)}${r.body.length > 2000 ? "..." : ""}`)
      .join("\n\n");

    const openai = new OpenAI({ apiKey: openaiKey });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You analyze email bodies from the same person and output ONLY evidence-based observations in JSON.

RULES:
- Extract ONLY what is clearly present in the text. Do not infer, speculate, or invent.
- Use null or omit a field when not clearly evident.
- tone: one short phrase describing tone if clearly evident from word choice and phrasing; otherwise null.
- formality: one short phrase if evident; otherwise null.
- structure_notes: only if clearly evident (e.g. "uses bullet points in multiple emails"). Otherwise null.
- style_prompt_fragment: one short sentence that describes ONLY what you observed (openings, sign-offs, sentence length, tone). No generic phrases. If nothing clear, null.

Do NOT output typical_openings, typical_sign_offs, or sentence_length — those are extracted from the text separately. Do NOT output vocabulary_tendencies, phrases_to_avoid, or punctuation_habits unless you have explicit evidence; prefer omitting.

Return ONLY valid JSON, no markdown:
{ "tone": string | null, "formality": string | null, "structure_notes": string | null, "style_prompt_fragment": string | null }`,
        },
        {
          role: "user",
          content: `Analyze these email bodies and output the JSON (tone, formality, structure_notes, style_prompt_fragment only; evidence-based):\n\n${sampleText}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });

    let raw = completion.choices[0]?.message?.content?.trim() ?? "";
    raw = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    let llmProfile: Record<string, unknown>;
    try {
      llmProfile = JSON.parse(raw);
    } catch {
      req.log.error({ rawSnippet: raw.slice(0, 200) }, "Invalid JSON from LLM");
      return res.status(502).json({ error: "Style analysis failed. Please try again." });
    }

    const profile: Record<string, unknown> = {
      version: 1,
      sentence_length: observed.sentence_length,
      typical_openings: observed.typical_openings,
      typical_sign_offs: observed.typical_sign_offs,
      vocabulary_tendencies: observed.vocabulary_tendencies,
      tone: llmProfile.tone ?? null,
      formality: llmProfile.formality ?? null,
      structure_notes: llmProfile.structure_notes ?? null,
      style_prompt_fragment: llmProfile.style_prompt_fragment ?? null,
    };
    const sanitized = sanitizeProfile(profile);

    const { data: existing } = await supabase.from("user_context").select("user_id, writing_style_profile").eq("user_id", user.id).single();
    if (existing) {
      // Merge: analysis-derived fields overwrite, but preserve any extra agent-set fields
      const merged = { ...(existing.writing_style_profile as Record<string, unknown> || {}), ...sanitized };
      await supabase
        .from("user_context")
        .update({ writing_style_profile: merged, updated_at: new Date().toISOString() })
        .eq("user_id", user.id);
    } else {
      await supabase.from("user_context").insert({ user_id: user.id, writing_style_profile: sanitized });
    }

    return res.json({ success: true, count: emails.length, writing_style_profile: sanitized });
  } catch (err) {
    req.log.error({ err }, "Error processing style examples");
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Internal server error",
    });
  }
});

export default router;
