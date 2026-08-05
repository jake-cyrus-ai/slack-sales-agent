/**
 * Contact Lookup Tool — query contacts and interaction history.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'contact_lookup' });

export function createContactLookupTool(userId: string, organizationId?: string | null) {
  return new DynamicStructuredTool({
    name: 'contact_lookup',
    description:
      'Look up a contact by name, email, or company domain. Returns relationship history, last interaction, and recent activity. Use when asked about a specific person or company relationship.',
    schema: z.object({
      query: z.string().describe('Name, email, or company to search for'),
      companyDomain: z.string().optional().describe('Company email domain to filter by (e.g. "ramp.com")'),
    }),
    func: async ({ query, companyDomain }) => {
      log.info({ query, companyDomain }, 'Looking up contact');

      try {
        // Text search on contacts table
        let contactQuery = supabase
          .from('contacts')
          .select('*')
          .eq('user_id', userId);
        if (organizationId) contactQuery = contactQuery.eq('organization_id', organizationId);
        contactQuery = contactQuery.limit(10);

        // Use ilike for flexible text matching
        if (companyDomain) {
          contactQuery = contactQuery.ilike('email', `%@${companyDomain}`);
        } else {
          contactQuery = contactQuery.or(
            `full_name.ilike.%${query}%,email.ilike.%${query}%,company_name.ilike.%${query}%`
          );
        }

        const { data: contacts, error } = await contactQuery;

        if (error) {
          log.error({ err: error }, 'Query error');
          return JSON.stringify({ error: error.message, results: [] });
        }

        if (!contacts || contacts.length === 0) {
          return JSON.stringify({ message: 'No contacts found matching this query.', results: [] });
        }

        // Fetch recent interactions for each contact
        const results = await Promise.all(
          contacts.map(async (contact: any) => {
            const { data: interactions } = await supabase
              .from('contact_interactions')
              .select('interaction_type, summary, interaction_date')
              .eq('contact_id', contact.id)
              .order('interaction_date', { ascending: false })
              .limit(5);

            return {
              name: contact.full_name,
              email: contact.email,
              company: contact.company_name,
              title: contact.title,
              relationshipType: contact.relationship_type,
              source: contact.source,
              recentInteractions: interactions || [],
              lastContactDate: interactions?.[0]?.interaction_date || null,
            };
          })
        );

        log.info({ count: results.length }, 'Found contacts');
        return JSON.stringify({ results });
      } catch (err: any) {
        log.error({ err }, 'Error looking up contact');
        return JSON.stringify({ error: err.message, results: [] });
      }
    },
  });
}
