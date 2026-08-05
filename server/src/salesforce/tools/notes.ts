/**
 * Salesforce Notes Tool — retrieve notes attached to records.
 * Queries both legacy Note objects and ContentNote (new-style notes).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_notes' });

export function createSfdcNotesTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_notes',
    description:
      'Retrieve notes attached to a Salesforce record (Account, Opportunity, Contact, etc.). Searches both legacy Notes and ContentNotes. Use when looking for internal notes, comments, or documentation on a deal or account.',
    schema: z.object({
      parentId: z.string().describe('The Salesforce record ID (Account, Opportunity, Contact, etc.) to find notes for'),
      searchText: z.string().optional().describe('Optional text to search within note titles or body'),
    }),
    func: async ({ parentId, searchText }) => {
      log.info({ parentId, searchText }, 'Searching notes');

      try {
        const conn = await getSalesforceConnection(organizationId);
        const safeId = sanitizeSoql(parentId);
        const allNotes: any[] = [];

        // Query legacy Note objects
        try {
          let noteQuery = `
            SELECT Id, Title, Body, OwnerId, Owner.Name,
                   CreatedDate, LastModifiedDate
            FROM Note
            WHERE ParentId = '${safeId}'
          `;
          if (searchText) {
            const safeText = sanitizeSoql(searchText);
            noteQuery += ` AND (Title LIKE '%${safeText}%' OR Body LIKE '%${safeText}%')`;
          }
          noteQuery += ` ORDER BY LastModifiedDate DESC LIMIT 20`;

          const noteResult = await conn.query(noteQuery);
          if (noteResult.records?.length) {
            allNotes.push(...noteResult.records.map((r: any) => ({ ...r, _noteType: 'Note' })));
          }
        } catch {
          // Legacy Note object may not be available in all orgs
        }

        // Query ContentNote via ContentDocumentLink
        try {
          const linkResult = await conn.query(`
            SELECT ContentDocumentId, ContentDocument.Title,
                   ContentDocument.LastModifiedDate,
                   ContentDocument.CreatedDate,
                   ContentDocument.Owner.Name
            FROM ContentDocumentLink
            WHERE LinkedEntityId = '${safeId}'
              AND ContentDocument.FileType = 'SNOTE'
            ORDER BY ContentDocument.LastModifiedDate DESC
            LIMIT 20
          `);

          if (linkResult.records?.length) {
            allNotes.push(...linkResult.records.map((r: any) => ({
              Id: r.ContentDocumentId,
              Title: r.ContentDocument?.Title,
              Owner: r.ContentDocument?.Owner,
              CreatedDate: r.ContentDocument?.CreatedDate,
              LastModifiedDate: r.ContentDocument?.LastModifiedDate,
              _noteType: 'ContentNote',
            })));
          }
        } catch {
          // ContentDocumentLink may fail if Enhanced Notes isn't enabled
        }

        if (allNotes.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_notes', parentId },
            message: 'No notes found for this record.',
            results: [],
          });
        }

        log.info({ count: allNotes.length }, 'Found notes');
        return JSON.stringify({
          _meta: { tool: 'sfdc_notes', parentId },
          results: allNotes,
        });
      } catch (err: any) {
        log.error({ err }, 'Error searching notes');
        return JSON.stringify({
          _meta: { tool: 'sfdc_notes', parentId },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
