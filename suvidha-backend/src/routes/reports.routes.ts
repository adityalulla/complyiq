import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  buildMonthlyGstReport,
  buildAnnualComplianceReport,
  buildVendorMismatchReport,
  buildTaxLiabilityReport,
  buildItcReport,
} from '../services/reports.service';
import { toCsv, toExcel, toPdf } from '../utils/reportExport';

export const reportRouter = Router();

const REPORT_TYPES = ['monthly-gst', 'annual-compliance', 'vendor-mismatch', 'tax-liability', 'itc'] as const;
type ReportType = (typeof REPORT_TYPES)[number];

async function generateReport(type: ReportType, businessId: string, query: any) {
  switch (type) {
    case 'monthly-gst': {
      const period = z.string().regex(/^\d{4}-\d{2}$/).parse(query.period);
      return buildMonthlyGstReport(businessId, period);
    }
    case 'annual-compliance': {
      const year = z.coerce.number().int().parse(query.year ?? new Date().getFullYear());
      return buildAnnualComplianceReport(businessId, year);
    }
    case 'vendor-mismatch':
      return buildVendorMismatchReport(businessId);
    case 'tax-liability': {
      const period = z.string().regex(/^\d{4}-\d{2}$/).parse(query.period);
      return buildTaxLiabilityReport(businessId, period);
    }
    case 'itc': {
      const period = z.string().regex(/^\d{4}-\d{2}$/).parse(query.period);
      return buildItcReport(businessId, period);
    }
  }
}

// GET /businesses/:businessId/reports/:type?period=2026-07 (or ?year=2026 for annual)
reportRouter.get(
  '/:businessId/reports/:type',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const type = req.params.type as ReportType;
    if (!REPORT_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unknown report type. Use one of: ${REPORT_TYPES.join(', ')}` });
    }
    try {
      const report = await generateReport(type, req.params.businessId, req.query);
      return res.json(report);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || 'Invalid report parameters' });
    }
  }
);

// GET /businesses/:businessId/reports/:type/export?format=pdf|excel|csv&period=2026-07
reportRouter.get(
  '/:businessId/reports/:type/export',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const type = req.params.type as ReportType;
    const format = req.query.format as string;

    if (!REPORT_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unknown report type. Use one of: ${REPORT_TYPES.join(', ')}` });
    }
    if (!['pdf', 'excel', 'csv'].includes(format)) {
      return res.status(400).json({ error: 'format must be pdf, excel, or csv' });
    }

    let report;
    try {
      report = await generateReport(type, req.params.businessId, req.query);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || 'Invalid report parameters' });
    }

    const filename = `${type}-${req.params.businessId.slice(0, 8)}`;

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return res.send(toCsv(report));
    }
    if (format === 'excel') {
      const buffer = await toExcel(report);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      return res.send(buffer);
    }
    // pdf
    const buffer = await toPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    return res.send(buffer);
  }
);
