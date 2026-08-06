import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

// Avant tout le reste : les messages de validation doivent sortir en français,
// et non dans l'anglais par défaut de Zod.
import './lib/validationLocale';

import prisma from './lib/prisma';
import { env } from './lib/env';
import { httpLogger } from './lib/httpLogger';
import { logger } from './lib/logger';
import { attendanceMeRoutes } from './routes/attendance.routes';
import { authRoutes } from './routes/auth.routes';
import { classRoutes } from './routes/class.routes';
import { dashboardRoutes } from './routes/dashboard.routes';
import { enrollmentRoutes } from './routes/enrollment.routes';
import { evaluationMeRoutes, evaluationRoutes } from './routes/evaluation.routes';
import { gradeRoutes, teacherMeRoutes } from './routes/grade.routes';
import { gradeTypeRoutes } from './routes/gradeType.routes';
import { onboardingRoutes } from './routes/onboarding.routes';
import { schoolYearRoutes } from './routes/schoolYear.routes';
import { staffRoutes } from './routes/staff.routes';
import { termRoutes } from './routes/term.routes';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { requireAuth } from './middlewares/requireAuth';
import { ALL_ROLES, requireRole } from './middlewares/requireRole';
import { schoolContext } from './middlewares/schoolContext';
import {
  childrenRoutes,
  gradeDetailRoutes,
  parentMeRoutes,
} from './routes/parent.routes';
import { parentSearchRoutes, studentRoutes } from './routes/student.routes';
import { publicRoute } from './middlewares/publicRoute';
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
  app.use(httpLogger);

  // Sondes de santé : avant le contexte école, elles doivent répondre même si
  // aucune école n'est résolue.
  app.get('/health', publicRoute, async (_req, res) => {
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

  /**
   * Déclenche une erreur volontaire, pour vérifier que la supervision reçoit
   * bien les événements.
   *
   * Développement strict : absente en production — une route qui plante à la
   * demande n'a rien à faire sur un serveur en service — et absente en test,
   * où elle fausserait le décompte des routes publiques de
   * `tests/route-guards.test.ts`.
   */
  if (env.NODE_ENV === 'development') {
    app.get('/debug/erreur-test', publicRoute, () => {
      throw new Error('Erreur de test Gesnotes — la supervision fonctionne');
    });
  }

  // Avant-inscription : recherche d'école et demande de rappel, avant qu'une
  // école existe ou soit résolue — comme /health, monté avant le contexte.
  app.use(onboardingRoutes);

  // Équipe Gesnotes : hors périmètre multi-écoles, monté pour la même raison.
  app.use('/staff', staffRoutes);

  // À partir d'ici, toute requête est rattachée à une école (plan §1.2).
  app.use(schoolContext);

  // Le rate-limit est posé route par route dans authRoutes : les routes de
  // session (/refresh, /logout) ne doivent pas consommer le budget
  // anti-bruteforce du login.
  app.use('/auth', authRoutes);
  // Référentiels : sans eux, aucun client ne peut construire les appels qui
  // exigent un `term_id` ou un `gradeTypeId`.
  app.use('/school-years', schoolYearRoutes);
  app.use('/terms', termRoutes);
  app.use('/grade-types', gradeTypeRoutes);
  app.use('/classes', classRoutes);
  app.use('/classes', enrollmentRoutes);
  app.use('/subjects', subjectRoutes);
  app.use('/students', studentRoutes);
  app.use('/parents/me', parentMeRoutes);
  app.use('/parents', parentSearchRoutes);
  app.use('/admin/dashboard', dashboardRoutes);
  app.use('/children', childrenRoutes);
  // Lecture avant écriture : GET /grades/:id est ouvert au parent, alors que
  // le reste de /grades est réservé aux enseignants.
  app.use('/grades', gradeDetailRoutes);
  app.use('/grades', gradeRoutes);
  app.use('/evaluations', evaluationRoutes);
  // Monté avant /teachers : /teachers/me ne doit pas être capté par /teachers/:id
  app.use('/teachers/me', teacherMeRoutes);
  app.use('/teachers/me', evaluationMeRoutes);
  app.use('/teachers/me', attendanceMeRoutes);
  app.use('/teachers', teacherRoutes);

  // Profil de l'utilisateur connecté — sert aussi de route témoin des gardes.
  app.get('/me', requireAuth, requireRole(...ALL_ROLES), (req, res) => {
    res.json(req.auth);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
