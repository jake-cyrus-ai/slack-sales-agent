/**
 * Build the URL where users can manage their integrations.
 * Evaluated at call-time so env vars are always resolved.
 */
export function getConnectUrl(): string {
  return `${process.env.FRONTEND_URL || 'https://your-app.example.com'}/profile`;
}
