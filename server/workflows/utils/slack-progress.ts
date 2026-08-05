/**
 * Slack Progress Notifications — single evolving message with checkmarks.
 *
 * Usage:
 *   const progress = new SlackProgress(botToken, channel);
 *   await progress.start("Processing email from John Smith (john@acme.co)");
 *   await progress.check("Qualified as customer_prospect (92%)");
 *   await progress.check("Researched Acme Corp — Series B fintech");
 *   await progress.complete(finalBlocks);
 */

import {
  sendSlackBlockMessage,
  updateSlackMessage,
  type SlackPostResult,
} from "./slack-helpers";

export class SlackProgress {
  private botToken: string;
  private channel: string;
  private teamId?: string;
  private messageTs: string | null = null;
  private title: string = "";
  private steps: string[] = [];

  constructor(botToken: string, channel: string, teamId?: string) {
    this.botToken = botToken;
    this.channel = channel;
    this.teamId = teamId;
  }

  /** Send the initial progress message. */
  async start(title: string): Promise<SlackPostResult> {
    this.title = title;
    this.steps = [];

    const blocks = this.buildBlocks(true);
    const result = await sendSlackBlockMessage(
      this.botToken,
      this.channel,
      title,
      blocks,
      undefined,
      this.teamId,
    );

    if (result.ok && result.ts) {
      this.messageTs = result.ts;
    }
    return result;
  }

  /** Add a completed step checkmark and update the message. */
  async check(stepDescription: string): Promise<void> {
    this.steps.push(stepDescription);
    if (!this.messageTs) return;

    const blocks = this.buildBlocks(true);
    await updateSlackMessage(
      this.botToken,
      this.channel,
      this.messageTs,
      this.title,
      blocks,
      this.teamId,
    );
  }

  /**
   * Replace the progress message with final notification blocks.
   * If no custom blocks provided, builds a completion summary.
   */
  async complete(finalBlocks?: any[]): Promise<void> {
    if (!this.messageTs) return;

    const blocks = finalBlocks || this.buildBlocks(false);
    await updateSlackMessage(
      this.botToken,
      this.channel,
      this.messageTs,
      this.title,
      blocks,
      this.teamId,
    );
  }

  /** Get the message timestamp (for threading or referencing). */
  getMessageTs(): string | null {
    return this.messageTs;
  }

  private buildBlocks(inProgress: boolean): any[] {
    const checkmarks = this.steps
      .map((s) => `:white_check_mark: ${s}`)
      .join("\n");

    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: inProgress ? `:hourglass_flowing_sand: ${this.title}` : `:white_check_mark: ${this.title}`,
          emoji: true,
        },
      },
    ];

    if (checkmarks) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: checkmarks,
        },
      });
    }

    if (inProgress) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "_Working..._",
          },
        ],
      });
    }

    return blocks;
  }
}
