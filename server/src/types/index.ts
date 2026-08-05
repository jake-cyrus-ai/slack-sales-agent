/**
 * Shared TypeScript types for the Sales Agent Knowledge server.
 */

// ─── Slack ──────────────────────────────────────────────────────────────────

export interface SlackWorkspace {
  id: string;
  team_id: string;
  team_name: string;
  bot_token: string;
  organization_id: string | null;
}

export interface SlackUserMapping {
  id: string;
  slack_workspace_id: string;
  slack_user_id: string;
  slack_email: string;
  agent_user_id: string;
  organization_id: string | null;
  is_active: boolean;
  metadata: Record<string, any>;
}

export interface SlackThreadConversation {
  id: string;
  slack_workspace_id: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  conversation_id: string;
  agent_user_id: string;
}

// ─── Conversations ──────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  source: 'slack' | 'web';
  created_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

// ─── Google Credentials ─────────────────────────────────────────────────────

export interface CalendarCredentials {
  id: string;
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expiry: string;
  calendar_email: string;
  sync_status: 'active' | 'expired';
}

// ─── Granola Credentials ───────────────────────────────────────────────────

export interface GranolaCredentials {
  id: string;
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_expiry: string | null;
  granola_email: string | null;
  sync_status: 'active' | 'expired' | 'disconnected' | 'error';
}

// ─── Knowledge Base ─────────────────────────────────────────────────────────

export interface ContextKnowledge {
  id: string;
  organization_id: string;
  title: string;
  content: string;
  category: string;
  subcategory?: string;
  tags?: string[];
  priority?: number;
  similarity?: number;
}

export interface ShareableDocument {
  id: string;
  organization_id: string;
  title: string;
  description: string;
  doc_type: string;
  file_name: string;
  file_path: string;
  download_url?: string;
  requires_nda?: boolean;
  similarity?: number;
}

// ─── Contacts ───────────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  company_name: string;
  title?: string;
  relationship_type?: 'customer' | 'prospect' | 'partner' | 'vendor';
  source?: string;
}

export interface ContactInteraction {
  id: string;
  contact_id: string;
  interaction_type: string;
  summary: string;
  interaction_date: string;
}

// ─── Agent ──────────────────────────────────────────────────────────────────

export interface Classification {
  domain: 'sales' | 'knowledge' | 'research';
  reasoning: string;
  confidence: number;
}
