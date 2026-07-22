import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import prisma from './lib/prisma';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { authRoutes } from './routes/auth.routes';
import { classRoutes } from './routes/class.routes';
import { gradeRoutes, teacherMeRoutes } from './routes/grade.routes';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { requireAuth } from './middlewares/requireAuth';
import { requireRole } from './middlewares/requireRole';
import { schoolContext } from './middlewares/schoolContext';
import {
  childrenRoutes,
  gradeDetailRoutes,
  parentMeRoutes,
} from './routes/parent.routes';
import { parentSearchRoutes, studentRoutes } from './routes/student.routes';
import { registerNotificationHandlers } from './services/notification.service';
import { subjectRoutes } from './routes/subject.routes';
import { teacherRoutes } from './routes/teacher.routes';

// Abonne les notifications aux événements de saisie (lot 9 → lot 11).
registerNotificationHandlers();

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
  app.use('/classes', classRoutes);
  app.use('/subjects', subjectRoutes);
  app.use('/students', studentRoutes);
  app.use('/parents/me', parentMeRoutes);
  app.use('/parents', parentSearchRoutes);
  app.use('/children', childrenRoutes);
  // Lecture avant écriture : GET /grades/:id est ouvert au parent, alors que
  // le reste de /grades est réservé aux enseignants.
  app.use('/grades', gradeDetailRoutes);
  app.use('/grades', gradeRoutes);
  // Monté avant /teachers : /teachers/me ne doit pas être capté par /teachers/:id
  app.use('/teachers/me', teacherMeRoutes);
  app.use('/teachers', teacherRoutes);

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
