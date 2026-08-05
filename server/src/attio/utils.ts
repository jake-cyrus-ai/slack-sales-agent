/**
 * Shared utilities for Attio API interactions.
 */

/**
 * Sanitize user input for safe use in API filter values.
 * Strips characters that could cause issues in JSON payloads.
 */
export function sanitizeInput(input: string): string {
  return input.replace(/[\x00\\]/g, '').trim(); // eslint-disable-line no-control-regex
}

/**
 * Extract a simple text value from an Attio attribute value.
 * Attio returns attribute values in a nested format.
 */
export function extractAttributeValue(values: any[] | undefined | null): string | null {
  if (!values || values.length === 0) return null;
  const first = values[0];

  // Handle different attribute value types
  if (first.value !== undefined) return String(first.value);
  if (first.full_name !== undefined) return first.full_name;
  if (first.email_address !== undefined) return first.email_address;
  if (first.phone_number !== undefined) return first.phone_number;
  if (first.domain !== undefined) return first.domain;
  if (first.currency_value !== undefined) return String(first.currency_value);
  if (first.target_object !== undefined) return first.target_record_id;
  if (first.option !== undefined) return first.option;

  return JSON.stringify(first);
}

/**
 * Flatten an Attio record's values into a simple key-value object.
 */
export function flattenRecordValues(values: Record<string, any[]>): Record<string, any> {
  const flat: Record<string, any> = {};
  for (const [key, attrValues] of Object.entries(values)) {
    if (!attrValues || attrValues.length === 0) {
      flat[key] = null;
      continue;
    }

    if (attrValues.length === 1) {
      flat[key] = extractAttributeValue(attrValues);
    } else {
      flat[key] = attrValues.map(v => extractAttributeValue([v]));
    }
  }
  return flat;
}

/**
 * Format an Attio record for tool output.
 */
export function formatRecord(record: any): Record<string, any> {
  return {
    id: record.id?.record_id || record.id,
    object: record.id?.object_id || null,
    values: flattenRecordValues(record.values || {}),
    created_at: record.created_at,
  };
}
