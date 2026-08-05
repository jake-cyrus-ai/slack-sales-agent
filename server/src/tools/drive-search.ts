/**
 * Google Drive Search Tool — search files in the user's Drive.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getGoogleTokens, googleApiFetch } from '../services/token-manager.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'drive_search' });

export function createDriveSearchTool(userId: string) {
  return new DynamicStructuredTool({
    name: 'drive_search',
    description:
      'Search Google Drive for files by name or content. Use when asked about documents, files, or shared resources in Google Drive.',
    schema: z.object({
      query: z.string().describe('Search query for file names or content'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Searching Google Drive');

      const tokens = await getGoogleTokens(userId);
      if (!tokens) {
        return JSON.stringify({
          error: 'Google Drive not connected. The drive.readonly scope may not be authorized.',
          results: [],
        });
      }

      try {
        const driveQuery = `fullText contains '${query.replace(/'/g, "\\'")}'`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(driveQuery)}&fields=files(id,name,mimeType,webViewLink,modifiedTime,owners)&pageSize=10`;

        const res = await googleApiFetch(url, tokens.accessToken);

        if (!res.ok) {
          const errText = await res.text();
          // Gracefully handle missing scope
          if (res.status === 403) {
            return JSON.stringify({
              error: 'Google Drive access not authorized. The user may need to grant drive.readonly scope.',
              results: [],
            });
          }
          return JSON.stringify({ error: `Drive API failed: ${res.status} - ${errText}`, results: [] });
        }

        const data = await res.json();
        const files = (data.files || []).map((f: any) => ({
          name: f.name,
          type: f.mimeType,
          link: f.webViewLink,
          modifiedTime: f.modifiedTime,
          owner: f.owners?.[0]?.displayName,
        }));

        log.info({ count: files.length }, 'Found files');
        return JSON.stringify({ results: files });
      } catch (err: any) {
        log.error({ err }, 'Error searching Drive');
        return JSON.stringify({ error: err.message, results: [] });
      }
    },
  });
}
