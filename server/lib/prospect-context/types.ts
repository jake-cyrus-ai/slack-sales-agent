/** SSE stream writer — passed into long-running agent handlers so they can stream progress. */
export interface SseWriter {
  send(event: string, data: Record<string, unknown>): void;
  done(): void;
  closed: boolean;
}

/** Cached enrichment payload for a prospect session. */
export interface SessionEnrichment {
  person?: {
    fullName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    title?: string | null;
    headline?: string | null;
    linkedinUrl?: string | null;
  } | null;
  company?: {
    name?: string | null;
    industry?: string | null;
    size?: string | null;
    stage?: string | null;
    description?: string | null;
    linkedinUrl?: string | null;
  } | null;
  confidence?: number;
}

/** Prospect session record. */
export interface ProspectSession {
  id: string;
  organizationId: string;
  capturedName: string | null;
  capturedEmail: string | null;
  capturedCompany: string | null;
  capturedRole: string | null;
  capturedUseCase: string | null;
  intent: string | null;
  enrichment: SessionEnrichment | null;
  status: "active" | "idle" | "closed" | "email_only";
  startedAt: string;
  lastActiveAt: string;
}
