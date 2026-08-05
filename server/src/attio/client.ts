/**
 * Attio connection manager — legacy module.
 *
 * The Attio integration now uses MCP protocol via `services/attio-client.ts`.
 * This file is kept for any remaining imports but the REST API wrapper
 * and AsyncLocalStorage context are no longer needed.
 *
 * @deprecated Use `services/attio-client.ts` (getAttioClient) instead.
 */

export { hasAttioConnection, getAttioClient } from '../services/attio-client.js';
