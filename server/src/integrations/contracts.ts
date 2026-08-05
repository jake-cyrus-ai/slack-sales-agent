export type IntegrationId =
  | "gmail"
  | "google-calendar"
  | "granola"
  | "salesforce"
  | "attio";

export type ConnectionStatus = "active" | "expired" | "revoked" | "error";

export interface IntegrationConnection {
  id: string;
  integrationId: IntegrationId;
  workspaceId: string;
  organizationId: string;
  userId?: string;
  scopes: string[];
  status: ConnectionStatus;
  expiresAt?: Date;
}

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: Date;
  providerMetadata?: Record<string, unknown>;
}

export interface OAuthContext {
  workspaceId: string;
  organizationId: string;
  userId?: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}

export interface OAuthCallback {
  code: string;
  state: string;
  redirectUri: string;
}

export interface IntegrationHealth {
  status: ConnectionStatus;
  checkedAt: Date;
  message?: string;
}

export interface CredentialStore {
  save(connection: IntegrationConnection, credentials: OAuthCredentials): Promise<void>;
  get(connectionId: string): Promise<OAuthCredentials | null>;
  revoke(connectionId: string): Promise<void>;
}

export interface IntegrationAdapter {
  readonly id: IntegrationId;
  authorizationUrl(context: OAuthContext): Promise<string>;
  handleCallback(callback: OAuthCallback): Promise<IntegrationConnection>;
  refresh(connection: IntegrationConnection): Promise<IntegrationConnection>;
  health(connection: IntegrationConnection): Promise<IntegrationHealth>;
}

/**
 * Credentials are deliberately excluded from provider operation inputs. An
 * adapter resolves them internally from a CredentialStore so tool arguments,
 * model context, Slack payloads, and logs never carry provider tokens.
 */
export interface IntegrationOperationContext {
  connection: IntegrationConnection;
  runId: string;
  actorUserId: string;
  idempotencyKey?: string;
}
