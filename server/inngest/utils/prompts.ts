/**
 * Shared LLM prompts for query parsing functions
 * 
 * Centralizes prompt templates to make maintenance easier and ensure consistency
 * across similar parsing functions (calendar, document, etc.)
 */

/**
 * Build conversation context string from message history
 */
export function buildConversationContext(conversationHistory: any[]): string {
  return conversationHistory.slice(-4).map((msg: any) =>
    `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
  ).join('\n');
}

/**
 * Generate the document query parsing prompt
 */
export function getDocumentQueryPrompt(
  query: string,
  conversationHistory: any[] = []
): string {
  const contextMessages = buildConversationContext(conversationHistory);

  return `Parse this message and determine if it's a document request. Extract the search query and intent.

${contextMessages ? `Recent Conversation Context:\n${contextMessages}\n\n` : ''}Current Query: "${query}"

Document request detection:
- Look for document-related intents: "get", "show", "fetch", "find", "list", "send me", "give me", "I need", "can you send"
- Detect requests for documents like: terms of service, privacy policy, SOC2, MSA, datasheets, contracts, etc.
- Handle variations: "terms of service", "ToS", "TOS", "terms", "privacy policy", "privacy", "SOC2", "SOC 2", etc.

Intent classification:
- "get": User wants a specific document (e.g., "get me the terms of service")
- "list": User wants to see all available documents or document types (e.g., "list documents", "what documents do you have")
- "search": User wants to search for documents matching a query (e.g., "find datasheets", "search for contracts")

Document type extraction:
- Extract specific document types if mentioned: "terms", "privacy", "soc2", "msa", "contract", "datasheet", etc.
- If no specific type mentioned, set doc_type to null
- Normalize variations (e.g., "ToS" -> "terms", "SOC 2" -> "soc2")

Query extraction:
- Extract the search query from the message
- For "get" intent, extract the document name/type
- For "list" intent, query can be empty or "all"
- For "search" intent, extract the search terms

Return ONLY a valid JSON object (no markdown, no code blocks, no explanation) with this exact format:
{
  "is_document_request": true or false,
  "query": "extracted search query or document name",
  "intent": "get" or "list" or "search",
  "doc_type": "document type string or null",
  "limit": number (default: 10, max: 50)
}

Examples:

1. Query: "get me the terms of service"
   {"is_document_request": true, "query": "terms of service", "intent": "get", "doc_type": "terms", "limit": 10}

2. Query: "I need the privacy policy"
   {"is_document_request": true, "query": "privacy policy", "intent": "get", "doc_type": "privacy", "limit": 10}

3. Query: "list documents"
   {"is_document_request": true, "query": "all", "intent": "list", "doc_type": null, "limit": 50}

4. Query: "what documents do you have"
   {"is_document_request": true, "query": "all", "intent": "list", "doc_type": null, "limit": 50}

5. Query: "find SOC2 documents"
   {"is_document_request": true, "query": "SOC2", "intent": "search", "doc_type": "soc2", "limit": 10}

6. Query: "search for datasheets"
   {"is_document_request": true, "query": "datasheets", "intent": "search", "doc_type": null, "limit": 10}

7. Query: "can you send me the ToS"
   {"is_document_request": true, "query": "ToS", "intent": "get", "doc_type": "terms", "limit": 10}

8. Query: "show me all contracts"
   {"is_document_request": true, "query": "contracts", "intent": "search", "doc_type": "contract", "limit": 10}

9. Query: "what's the weather today"
   {"is_document_request": false, "query": "", "intent": "search", "doc_type": null, "limit": 10}

10. Query: "help me with my calendar"
   {"is_document_request": false, "query": "", "intent": "search", "doc_type": null, "limit": 10}

11. Context: "User: list documents"
    Query: "get me the first one"
    {"is_document_request": true, "query": "first", "intent": "get", "doc_type": null, "limit": 10}

Important:
- Only set is_document_request to true if the message is clearly requesting documents
- Extract meaningful queries - don't just return the entire message
- For "list" intent, typically set limit to 50 to show more results
- Normalize document types to lowercase (e.g., "terms", "privacy", "soc2")
- If intent is unclear, default to "search"`;
}

/**
 * Generate the calendar query parsing prompt
 */
export function getCalendarQueryPrompt(
  query: string,
  conversationHistory: any[] = [],
  today: Date,
  now: Date
): string {
  const contextMessages = buildConversationContext(conversationHistory);
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const todayISO = today.toISOString();
  const nowISO = now.toISOString();
  const endOfDayISO = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999).toISOString();

  return `Today is ${todayStr} (${todayISO}).

Parse this calendar query and extract the date range and any specific meeting keywords.

${contextMessages ? `Recent Conversation Context:\n${contextMessages}\n\n` : ''}Current Query: "${query}"

CRITICAL: ALWAYS extract person names and company names as keywords, even if no explicit date is mentioned.

Date rules:
- If conversation context mentions a date (like "tomorrow", "next Monday"), use that date for the current query
- If query mentions specific names/companies WITHOUT a date, search TODAY ONLY (not next 7 days)
- If query explicitly mentions a date, use that date

Keyword rules:
- ALWAYS extract person names (first and last names separately)
- ALWAYS extract company names
- Extract ALL capitalized words that look like names
- Do NOT skip keywords just because there's no date mentioned

Return ONLY a valid JSON object (no markdown, no code blocks, no explanation) with this exact format:
{
  "dateFrom": "ISO datetime string for start of range (00:00:00)",
  "dateTo": "ISO datetime string for end of range (23:59:59)",
  "relative": "human-readable description",
  "keywords": ["array", "of", "names", "or", "companies"]
}

Examples:

1. Query: "What meetings do I have next Monday?"
   {"dateFrom": "2025-12-16T00:00:00.000Z", "dateTo": "2025-12-16T23:59:59.999Z", "relative": "next Monday", "keywords": []}

2. Query: "when is my next meeting"
   {"dateFrom": "${nowISO}", "dateTo": "${endOfDayISO}", "relative": "today", "keywords": []}

3. Query: "Prep for my call with Acme Corp tomorrow"
   {"dateFrom": "2025-12-13T00:00:00.000Z", "dateTo": "2025-12-13T23:59:59.999Z", "relative": "tomorrow", "keywords": ["acme", "corp"]}

4. Context: "User: What meetings do I have tomorrow?"
   Query: "prep for hani"
   {"dateFrom": "2025-12-13T00:00:00.000Z", "dateTo": "2025-12-13T23:59:59.999Z", "relative": "tomorrow", "keywords": ["hani"]}

5. Query: "prep for elizabeth pullman"
   {"dateFrom": "2025-12-12T00:00:00.000Z", "dateTo": "2025-12-12T23:59:59.999Z", "relative": "today", "keywords": ["elizabeth", "pullman"]}
   (Search TODAY when names mentioned without date)

6. Query: "Can you prep for my meeting with Kevin Liu"
   {"dateFrom": "2025-12-12T00:00:00.000Z", "dateTo": "2025-12-12T23:59:59.999Z", "relative": "today", "keywords": ["kevin", "liu"]}
   (Extract both first and last name, search today)

7. Query: "prep for my meeting with Tenex"
   {"dateFrom": "2025-12-12T00:00:00.000Z", "dateTo": "2025-12-12T23:59:59.999Z", "relative": "today", "keywords": ["tenex"]}
   (Extract company name, search today)

Important:
- Calculate actual ISO datetime strings based on today's date
- For "next meeting" or "when is my next meeting", use NOW as dateFrom (not start of day)
- For day names like "Monday", "Friday", calculate the next occurrence of that day
- For "this week", use today through 7 days from now
- For "next week", use 7 days from now through 14 days from now
- ALWAYS extract names/companies as keywords - this is critical for filtering`;
}

/**
 * System message for document query parser
 */
export const DOCUMENT_QUERY_PARSER_SYSTEM = 'You are a document request parser. Return only valid JSON, no markdown formatting.';

/**
 * System message for calendar query parser
 */
export const CALENDAR_QUERY_PARSER_SYSTEM = 'You are a date parser. Return only valid JSON, no markdown formatting.';
