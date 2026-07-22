import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import prisma from './lib/prisma';
import { logger } from './lib/logger';
import { authLimiter } from './middlewares/rateLimit';
import { authRoutes } from './routes/auth.routes';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { requireAuth } from './middlewares/requireAuth';
import { requireRole } from './middlewares/requireRole';
import { schoolContext } from './middlewares/schoolContext';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // sous-domaines et IP réelles derrière un reverse proxy

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(pinoHttp({ logger }));

  // Sondes de santé : avant le contexte école, elles doivent répondre même si
  // aucune école n'est résolue.
  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'connected' });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: error instanceof Error ? error.message : 'erreur inconnue',
      });
    }
  });

  // À partir d'ici, toute requête est rattachée à une école (plan §1.2).
  app.use(schoolContext);

  app.use('/auth', authLimiter, authRoutes);

  // Profil de l'utilisateur connecté — sert aussi de route témoin des gardes.
  app.get('/me', requireAuth, (req, res) => {
    res.json(req.auth);
  });

  app.get('/admin/ping', requireAuth, requireRole('admin'), (_req, res) => {
    res.json({ ok: true });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
