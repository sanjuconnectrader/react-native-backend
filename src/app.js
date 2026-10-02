import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { UniqueConstraintError, ForeignKeyConstraintError } from 'sequelize';
import { config } from './config/env.js';
import { HttpError } from './errors/http-error.js';
import authRoutes from './routes/auth.js';
import posRoutes from './routes/pos.js';
import { countryOptions } from './services/country-service.js';

export const app = express();
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)) }));
app.use(express.json({ limit: '100kb' }));
app.get('/api/countries', (_req, res) => res.json({ success: true, message: 'OK', data: countryOptions }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), authRoutes);
app.use('/api', posRoutes);
app.get('/health', (_req, res) => res.json({ success: true, message: 'OK', data: { status: 'up' } }));
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));
app.use((error, _req, res, _next) => {
  let status = error.status || error.cause?.status || 500;
  let code = error.code || error.cause?.code || 'INTERNAL_ERROR';
  let message = error.message;
  if (error instanceof UniqueConstraintError) { status = 409; code = 'DUPLICATE_RECORD'; message = 'Record already exists'; }
  else if (error instanceof ForeignKeyConstraintError) { status = 400; code = 'INVALID_REFERENCE'; message = 'Referenced record does not exist'; }
  if (status >= 500 && !(error instanceof HttpError)) { console.error(error); message = 'Internal server error'; }
  res.status(status).json({ success: false, message, errorCode: code });
});
