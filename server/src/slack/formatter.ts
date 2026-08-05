/**
 * Convert agent response to Slack Block Kit format.
 * Ported from slack-bot-handler/index.ts:1004-1062.
 */

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<Record<string, any>>;
  block_id?: string;
}

export interface SourceInfo {
  filename?: string;
  title?: string;
  similarity?: number;
}

export function formatMessageForSlack(
  content: string,
  sources?: SourceInfo[],
  confidence?: number,
  hasConflicts?: boolean,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  let formatted = content;

  // Convert **bold** → *bold* (Slack uses single asterisks)
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Remove markdown header markers
  formatted = formatted.replace(/^#{1,6}\s+/gm, '');

  // Convert markdown bullets to Slack bullets
  formatted = formatted.replace(/^[-*]\s+/gm, '• ');

  // Collapse excessive newlines
  formatted = formatted.replace(/\n{3,}/g, '\n\n');

  formatted = formatted.trim();

  // Split into 3000-char blocks if needed
  const chunks: string[] = [];
  if (formatted.length <= 3000) {
    chunks.push(formatted);
  } else {
    let remaining = formatted;
    while (remaining.length > 0) {
      if (remaining.length <= 3000) {
        chunks.push(remaining);
        break;
      }
      // Try to break at a newline
      let breakPoint = remaining.lastIndexOf('\n', 3000);
      if (breakPoint < 1000) breakPoint = 2997;
      chunks.push(remaining.substring(0, breakPoint));
      remaining = remaining.substring(breakPoint).trimStart();
    }
  }

  for (const chunk of chunks) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: chunk },
    });
  }

  // Add sources as context block
  if (sources && sources.length > 0) {
    const sourceText = sources
      .slice(0, 5)
      .map((s, i) => {
        const name = s.title || s.filename || 'Document';
        const sim = s.similarity != null ? ` (${Math.round(s.similarity * 100)}% match)` : '';
        return `${i + 1}. ${name}${sim}`;
      })
      .join('\n');

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📚 *Sources:*\n${sourceText}` }],
    });
  }

  // Add confidence indicator if present
  if (confidence != null && confidence > 0) {
    const pct = Math.round(confidence * 100);
    const label = hasConflicts ? 'Conflicting' : confidence >= 0.8 ? 'Confirmed' : 'Likely';
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Confidence: ${label} (${pct}%)${hasConflicts ? ' — conflicting sources detected' : ''}` }],
    });
  }

  return blocks;
}

/**
 * Build a Slack Block Kit actions block with a "Connect [label]" URL button.
 * Uses a `url` field so Slack opens the link directly — no interactivity handler needed.
 */
export function buildConnectBlock(label: string, connectUrl: string): SlackBlock {
  const slug = label.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return {
    type: 'actions',
    block_id: `connect_${slug}`,
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: `Connect ${label}`, emoji: true },
      url: connectUrl,
      action_id: `connect_${slug}`,
    }],
  };
}
