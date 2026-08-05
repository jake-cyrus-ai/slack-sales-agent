/**
 * Send Organization Invite - Admin Inngest Function
 *
 * Sends an organization membership invite by:
 * 1. Fetching invite details from DB
 * 2. Generating the accept URL
 * 3. DMing the inviting admin via Slack with the link to forward
 *
 * Email delivery (Resend/SendGrid) is a future enhancement; until then the
 * invite URL is delivered to the admin who created the invite so they can
 * share it directly with the recipient.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils";
import { postDmToUser } from "../../utils/slack-helpers";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "send-organization-invite" });

export interface SendOrganizationInviteData {
  inviteId: string;
}

export const sendOrganizationInvite = inngest.createFunction(
  {
    id: "send-organization-invite",
    retries: 2,
  },
  { event: "admin/send-organization-invite" },
  async ({ event, step }) => {
    const { inviteId } = event.data;

    log.info({ inviteId }, "Processing invite");

    // Step 1: Fetch invite details
    const invite = await step.run("fetch-invite-details", async () => {
      const supabase = getSupabaseAdmin();

      const { data, error } = await supabase
        .from("organization_invites")
        .select(`*, organizations(name, slug)`)
        .eq("id", inviteId)
        .single();

      if (error || !data) {
        throw new Error(`Invite not found: ${error?.message}`);
      }

      return data;
    });

    // Step 2: Generate the accept URL
    const inviteUrl = await step.run("generate-invite-url", async () => {
      const frontendUrl =
        process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL || "https://your-app.example.com";
      return `${frontendUrl}/onboarding?token=${invite.token}`;
    });

    // Step 3: Notify the inviting admin via Slack DM so they can forward the link
    const result = await step.run("notify-inviter", async () => {
      const orgName = (invite.organizations as { name?: string } | null)?.name || "your organization";
      const recipientLabel = invite.recipient_name || invite.email || "your invitee";

      const invitedByUserId: string | null = invite.invited_by ?? null;

      if (invitedByUserId) {
        const organizationId: string | null = invite.organization_id ?? null;

        if (organizationId) {
          const dmResult = await postDmToUser({
            agentUserId: invitedByUserId,
            organizationId,
            text: `Your invite for *${recipientLabel}* to join *${orgName}* is ready.\n\nShare this link with them:\n${inviteUrl}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Your invite for *${recipientLabel}* to join *${orgName}* is ready. Share this link with them:`,
                },
              },
              {
                type: "section",
                text: { type: "mrkdwn", text: `\`${inviteUrl}\`` },
              },
            ],
          });

          if (dmResult.ok) {
            log.info({ invitedByUserId, inviteId }, "Invite link sent via Slack DM");
            return {
              success: true,
              delivery: "slack_dm",
              inviteUrl,
              recipientName: invite.recipient_name,
              email: invite.email,
              organizationName: orgName,
            };
          }

          log.warn({ err: dmResult.error, invitedByUserId }, "Slack DM failed, falling back to log");
        }
      }

      // Fallback: log so the URL is visible in server logs / Inngest trace
      log.info({ inviteUrl, email: invite.email, orgName }, "Invite URL (no Slack mapping — share manually)");

      return {
        success: true,
        delivery: "log_only",
        inviteUrl,
        recipientName: invite.recipient_name,
        email: invite.email,
        organizationName: orgName,
      };
    });

    return result;
  }
);
