import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { z } from 'zod';
import { InvoiceDirection, InvoiceSource } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

export const invoiceRouter = Router();

// Local disk storage for now - swap for S3 (or equivalent) before real launch,
// per the file storage layer in the architecture doc. Keeping it local here
// so the route is fully runnable without needing cloud credentials yet.
const upload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadMetaSchema = z.object({
  invoiceNumber: z.string().min(1),
  direction: z.nativeEnum(InvoiceDirection),
  supplierOrCustomerName: z.string().min(1),
  supplierGstin: z.string().optional(),
  invoiceDate: z.string(),
  taxableValue: z.coerce.number(),
  gstRate: z.coerce.number(),
  gstAmount: z.coerce.number(),
  totalAmount: z.coerce.number(),
});

// POST /businesses/:businessId/invoices/upload
// A business owner or accountant uploads one invoice (PDF/image) along with
// its key details. Note: this version takes the details as typed-in fields
// alongside the file - automatic extraction (reading the PDF/image itself
// and pulling out these fields with OCR/AI) is a fast follow, but shipping
// the manual version first means reconciliation can be tested immediately
// without waiting on that extraction accuracy to be tuned.
invoiceRouter.post(
  '/:businessId/invoices/upload',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  upload.single('file'),
  async (req, res) => {
    const parsed = uploadMetaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { businessId } = req.params;
    const data = parsed.data;

    const existing = await prisma.invoice.findUnique({
      where: {
        businessId_invoiceNumber_direction: {
          businessId,
          invoiceNumber: data.invoiceNumber,
          direction: data.direction,
        },
      },
    });
    if (existing) {
      return res.status(409).json({
        error: `Invoice ${data.invoiceNumber} already exists for this business - possible duplicate.`,
      });
    }

    const invoice = await prisma.invoice.create({
      data: {
        businessId,
        invoiceNumber: data.invoiceNumber,
        direction: data.direction,
        supplierOrCustomerName: data.supplierOrCustomerName,
        supplierGstin: data.supplierGstin,
        invoiceDate: new Date(data.invoiceDate),
        taxableValue: data.taxableValue,
        gstRate: data.gstRate,
        gstAmount: data.gstAmount,
        totalAmount: data.totalAmount,
        source: InvoiceSource.MANUAL_UPLOAD,
        rawFileUrl: req.file ? `/uploads/${req.file.filename}` : null,
      },
    });

    
    return res.status(201).json(invoice);
  }
);

const listQuerySchema = z.object({
  direction: z.nativeEnum(InvoiceDirection).optional(),
  supplier: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

// GET /businesses/:businessId/invoices - filterable, paginated list.
invoiceRouter.get(
  '/:businessId/invoices',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { direction, supplier, from, to, page, pageSize } = parsed.data;

    const where: any = { businessId: req.params.businessId };
    if (direction) where.direction = direction;
    if (supplier) where.supplierOrCustomerName = { contains: supplier, mode: 'insensitive' };
    if (from || to) {
      where.invoiceDate = {};
      if (from) where.invoiceDate.gte = new Date(from);
      if (to) where.invoiceDate.lte = new Date(to);
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { invoiceDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.invoice.count({ where }),
    ]);

    return res.json({
      invoices,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  }
);

// GET /businesses/:businessId/invoices/:id
invoiceRouter.get(
  '/:businessId/invoices/:id',
  requireAuth,
  requireRole('OWNER', 'ACCOUNTANT', 'ADMIN'),
  async (req, res) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.params.businessId },
    });
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    return res.json(invoice);
  }
);
