/**
 * Salesforce-specific Slack Block Kit formatter.
 *
 * Converts agent responses (already in Slack mrkdwn from the system prompt)
 * into proper Block Kit blocks for rich Slack rendering.
 */

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
}

const MAX_SECTION_LENGTH = 3000;

export function formatSalesforceResponse(content: string): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  let formatted = content;

  // Convert any remaining **bold** to *bold* (Slack uses single asterisks)
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Remove markdown header markers (## Header → just the text)
  formatted = formatted.replace(/^#{1,6}\s+/gm, '');

  // Convert markdown bullets to Slack bullets
  formatted = formatted.replace(/^[-]\s+/gm, '• ');

  // Convert --- to divider markers (we'll handle these as block splits)
  const sections = formatted.split(/^---$/m).map((s) => s.trim()).filter(Boolean);

  for (const section of sections) {
    if (blocks.length > 0) {
      blocks.push({ type: 'divider' });
    }

    const chunks = splitToChunks(section, MAX_SECTION_LENGTH);
    for (const chunk of chunks) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: chunk },
      });
    }
  }

  return blocks;
}

function splitToChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a double newline (paragraph boundary)
    let breakPoint = remaining.lastIndexOf('\n\n', maxLength);
    if (breakPoint < maxLength * 0.3) {
      // Fall back to single newline
      breakPoint = remaining.lastIndexOf('\n', maxLength);
    }
    if (breakPoint < maxLength * 0.3) {
      // Last resort: hard break
      breakPoint = maxLength - 3;
    }

    chunks.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint).trimStart();
  }

  return chunks;
}
