import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { authRouter } from './routes/auth.routes';
import { userRouter } from './routes/user.routes';
import { businessRouter } from './routes/business.routes';
import { invoiceRouter } from './routes/invoice.routes';
import { integrationRouter } from './routes/integration.routes';
import { gstReturnRouter } from './routes/gstReturn.routes';
import { reconciliationRouter } from './routes/reconciliation.routes';
import { filingRouter } from './routes/filing.routes';
import { aiRouter } from './routes/ai.routes';
import { notificationRouter } from './routes/notification.routes';
import { reportRouter } from './routes/reports.routes';

const app = express();

app.use(cors());
app.use(express.json());

// Simple request log - swap for a real logger (pino/winston) before production
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRouter);
app.use('/', userRouter); // exposes GET /me
app.use('/businesses', businessRouter);
app.use('/businesses', invoiceRouter);
app.use('/businesses', integrationRouter);
app.use('/businesses', gstReturnRouter);
app.use('/businesses', reconciliationRouter);
app.use('/businesses', filingRouter);
app.use('/businesses', aiRouter);
app.use('/businesses', notificationRouter);
app.use('/businesses', reportRouter);
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Catch-all error handler - makes sure unexpected errors return clean JSON
// instead of leaking stack traces to the client.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Suvidha backend (Milestone 1) running on http://localhost:${PORT}`);
});
