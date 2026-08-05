/**
 * Salesforce Reports Tool — list and run existing Salesforce reports.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_reports' });

export function createSfdcReportsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_reports',
    description:
      'List or run existing Salesforce reports. Use "list" action to find reports by name, or "run" action with a report ID to execute a report and get its results. Useful for pipeline summaries, forecast reports, and activity dashboards.',
    schema: z.object({
      action: z.enum(['list', 'run']).describe('"list" to search for reports by name, "run" to execute a specific report'),
      reportName: z.string().optional().describe('Report name to search for (used with "list" action)'),
      reportId: z.string().optional().describe('Salesforce Report ID to execute (used with "run" action)'),
    }),
    func: async ({ action, reportName, reportId }) => {
      log.info({ action, reportName, reportId }, 'Reports request');

      try {
        const conn = await getSalesforceConnection(organizationId);

        if (action === 'list') {
          let query = `SELECT Id, Name, Description, FolderName, Format, LastRunDate
                        FROM Report`;
          if (reportName) {
            query += ` WHERE Name LIKE '%${sanitizeSoql(reportName)}%'`;
          }
          query += ` ORDER BY LastRunDate DESC NULLS LAST LIMIT 20`;

          const result = await conn.query(query);

          if (!result.records || result.records.length === 0) {
            return JSON.stringify({
              _meta: { tool: 'sfdc_reports', action, reportName },
              message: reportName
                ? `No reports found matching "${reportName}".`
                : 'No reports found.',
              results: [],
            });
          }

          log.info({ count: result.records.length }, 'Found reports');
          return JSON.stringify({
            _meta: { tool: 'sfdc_reports', action, reportName },
            results: result.records,
          });
        }

        // action === 'run'
        if (!reportId) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_reports', action },
            error: 'reportId is required for the "run" action. Use "list" first to find report IDs.',
            results: [],
          });
        }

        const safeId = sanitizeSoql(reportId);

        // Use the Analytics API to run the report
        const reportResult = await conn.request({
          method: 'GET',
          url: `/services/data/v59.0/analytics/reports/${safeId}?includeDetails=true`,
        }) as any;

        const summary = {
          reportName: reportResult.reportMetadata?.name,
          reportId: reportResult.reportMetadata?.id,
          reportFormat: reportResult.reportMetadata?.reportFormat,
          groupingsDown: reportResult.groupingsDown?.groupings?.map((g: any) => g.label) || [],
          aggregates: reportResult.reportResult?.reportMetadata?.aggregates || [],
          factMap: summarizeFactMap(reportResult.factMap),
          rowCount: reportResult.reportMetadata?.reportFormat === 'TABULAR'
            ? reportResult.factMap?.['T!T']?.rows?.length || 0
            : Object.keys(reportResult.factMap || {}).length,
        };

        log.info({ reportName: summary.reportName, rowCount: summary.rowCount }, 'Ran report');
        return JSON.stringify({
          _meta: { tool: 'sfdc_reports', action, reportId },
          results: summary,
        });
      } catch (err: any) {
        log.error({ err }, 'Error with reports');
        return JSON.stringify({
          _meta: { tool: 'sfdc_reports', action },
          error: err.message,
          results: [],
        });
      }
    },
  });
}

function summarizeFactMap(factMap: any): any {
  if (!factMap) return null;

  const entries = Object.entries(factMap).slice(0, 10);
  const summary: Record<string, any> = {};

  for (const [key, value] of entries) {
    const fact = value as any;
    summary[key] = {
      aggregates: fact.aggregates?.map((a: any) => ({ label: a.label, value: a.value })),
      rowCount: fact.rows?.length || 0,
    };
  }

  return summary;
}
