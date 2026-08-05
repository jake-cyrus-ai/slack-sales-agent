/**
 * Slack Action Registry
 *
 * Module-registered handlers for Slack interactive components (block_actions).
 * Replaces prefix-matched routing in slack-interaction.ts with a centralized
 * registry that each domain module registers into.
 *
 * Usage:
 *   // In domain module (e.g., deal-actions.ts):
 *   registerActions("deal_", handleDealAction);
 *
 *   // In slack-interaction.ts:
 *   const result = await dispatchAction(actionId, ctx);
 */

/**
 * Context passed to every action handler. Contains everything needed
 * to process a Slack interaction without additional DB lookups.
 */
export interface ActionContext {
  actionId: string;
  actionValue: string;
  botToken: string;
  channelId: string;
  messageTs: string;
  slackUserId: string;
  triggerId?: string; // For opening Slack modals
  userMapping: { agent_user_id: string; organization_id: string };
  step: any; // Vercel Workflow step object
}

export interface ActionResult {
  status: string;
  [key: string]: any;
}

type ActionHandler = (ctx: ActionContext) => Promise<ActionResult>;

type RegistryEntry = {
  prefix: string;
  handler: ActionHandler;
};

const registry: RegistryEntry[] = [];

/**
 * Register a handler for all action IDs matching the given prefix.
 * Handlers are matched in registration order — first match wins.
 *
 * @param prefix - Action ID prefix to match (e.g., "deal_", "meeting_", "email_")
 * @param handler - Async function that processes the action
 */
export function registerActions(prefix: string, handler: ActionHandler): void {
  registry.push({ prefix, handler });
}

/**
 * Dispatch an action to the first matching registered handler.
 * Returns null if no handler matches the action ID.
 */
export async function dispatchAction(
  actionId: string,
  ctx: ActionContext,
): Promise<ActionResult | null> {
  for (const entry of registry) {
    if (actionId.startsWith(entry.prefix) || actionId === entry.prefix) {
      return entry.handler(ctx);
    }
  }
  return null;
}

/**
 * Check if any handler is registered for the given action ID.
 */
export function hasHandler(actionId: string): boolean {
  return registry.some(
    (entry) => actionId.startsWith(entry.prefix) || actionId === entry.prefix,
  );
}

/** @internal Exposed for tests only. */
export function __resetRegistryForTests(): void {
  registry.length = 0;
}
