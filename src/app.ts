import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import prisma from './lib/prisma';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { authRoutes } from './routes/auth.routes';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { requireAuth } from './middlewares/requireAuth';
import { requireRole } from './middlewares/requireRole';
import { schoolContext } from './middlewares/schoolContext';

export function createApp() {
  const app = express();

  // 0 par défaut : ne faire confiance à X-Forwarded-For que si un reverse
  // proxy est réellement devant (TRUST_PROXY_HOPS), sinon le rate-limit se
  // contourne avec un en-tête forgé.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

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
      // Route publique : le détail (hôte, port, utilisateur de la base) reste
      // dans les logs et ne part jamais au client.
      logger.error({ err: error }, 'Sonde /health : base injoignable');
      res.status(500).json({ status: 'error', database: 'unreachable' });
    }
  });

  // À partir d'ici, toute requête est rattachée à une école (plan §1.2).
  app.use(schoolContext);

  // Le rate-limit est posé route par route dans authRoutes : les routes de
  // session (/refresh, /logout) ne doivent pas consommer le budget
  // anti-bruteforce du login.
  app.use('/auth', authRoutes);

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
