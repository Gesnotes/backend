import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

// Avant tout le reste : les messages de validation doivent sortir en français,
// et non dans l'anglais par défaut de Zod.
import './lib/validationLocale';

import prisma from './lib/prisma';
import { corsAllowedHost, env, isProduction } from './lib/env';
import { httpLogger } from './lib/httpLogger';
import { logger } from './lib/logger';
import { attendanceMeRoutes } from './routes/attendance.routes';
import { auditRoutes } from './routes/audit.routes';
import { authRoutes } from './routes/auth.routes';
import { classRoutes } from './routes/class.routes';
import { dashboardRoutes } from './routes/dashboard.routes';
import { enrollmentRoutes } from './routes/enrollment.routes';
import { evaluationMeRoutes, evaluationRoutes } from './routes/evaluation.routes';
import { gradeRoutes, teacherMeRoutes } from './routes/grade.routes';
import { gradeTypeRoutes } from './routes/gradeType.routes';
import { holidayRoutes } from './routes/holiday.routes';
import { identifyRoutes } from './routes/identify.routes';
import { onboardingRoutes } from './routes/onboarding.routes';
import { scheduleMeRoutes, scheduleRoutes } from './routes/schedule.routes';
import { schoolRoutes } from './routes/school.routes';
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
import { userRoutes } from './routes/user.routes';

// Abonne les notifications aux événements de saisie (lot 9 → lot 11).
registerNotificationHandlers();

/**
 * Liste blanche CORS.
 *
 * `cors()` sans options reflète n'importe quelle origine : l'authentification
 * se fait par jeton porteur (pas de cookie), donc pas la faille classique
 * « wildcard + credentials », mais ça laisse n'importe quel site fabriquer des
 * appels vers l'API et lire du JSON, dès qu'il obtient un jeton par un autre
 * moyen. Une seule origine autorisée désormais (`corsAllowedHost`, dérivée de
 * `WEB_APP_URL`) : plus de sous-domaine par école à wildcarder, le JWT seul
 * fait autorité pour l'identité de l'école.
 *
 * Sans en-tête `Origin` (health check, appel serveur-à-serveur, tests) :
 * toujours autorisé — cet en-tête n'existe que pour les requêtes navigateur
 * réellement cross-origin.
 */
function isAllowedOrigin(
  requestOrigin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!requestOrigin) return callback(null, true);

  try {
    const { hostname } = new URL(requestOrigin);

    if (!isProduction && (hostname === 'localhost' || hostname === '127.0.0.1')) {
      return callback(null, true);
    }

    if (corsAllowedHost && hostname === corsAllowedHost) {
      return callback(null, true);
    }

    return callback(null, false);
  } catch {
    return callback(null, false);
  }
}

export function createApp() {
  const app = express();

  // 0 par défaut : ne faire confiance à X-Forwarded-For que si un reverse
  // proxy est réellement devant (TRUST_PROXY_HOPS), sinon le rate-limit se
  // contourne avec un en-tête forgé.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(helmet());
  app.use(cors({ origin: isAllowedOrigin }));
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

  // Connexion sans sous-domaine connu (plan §1.2 ter) : aucune école résolue
  // à ce stade, l'identifiant est cherché à travers toutes les écoles — voir
  // identify.routes.ts.
  app.use('/auth', identifyRoutes);

  // À partir d'ici, toute requête est rattachée à une école (plan §1.2).
  app.use(schoolContext);

  // Le rate-limit est posé route par route dans authRoutes : les routes de
  // session (/refresh, /logout) ne doivent pas consommer le budget
  // anti-bruteforce du login.
  app.use('/auth', authRoutes);
  // Référentiels : sans eux, aucun client ne peut construire les appels qui
  // exigent un `term_id` ou un `gradeTypeId`.
  app.use('/school', schoolRoutes);
  app.use('/school-years', schoolYearRoutes);
  app.use('/terms', termRoutes);
  app.use('/grade-types', gradeTypeRoutes);
  app.use('/holidays', holidayRoutes);
  app.use('/classes', classRoutes);
  // Avant enrollmentRoutes : sa garde de rôle (admin+enseignant) est plus
  // large que celle d'enrollmentRoutes (admin seul), qui intercepterait sinon
  // en 403 tout enseignant sur un chemin /classes/:id/... qu'elle ne gère
  // pas elle-même (son `.use(requireRole('admin'))` n'est pas scopé à ses
  // seules routes).
  app.use('/classes', scheduleRoutes);
  app.use('/classes', enrollmentRoutes);
  app.use('/subjects', subjectRoutes);
  app.use('/students', studentRoutes);
  app.use('/parents/me', parentMeRoutes);
  app.use('/parents', parentSearchRoutes);
  app.use('/admin/dashboard', dashboardRoutes);
  app.use('/admin/audit-logs', auditRoutes);
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
  app.use('/teachers/me', scheduleMeRoutes);
  app.use('/teachers', teacherRoutes);
  app.use('/users', userRoutes);

  // Profil de l'utilisateur connecté — sert aussi de route témoin des gardes.
  //
  // `schoolName` n'est pas dans le JWT (il porte seulement `schoolId`) et
  // n'est renvoyé par `/auth/identify` qu'au moment de la connexion, jamais
  // conservé côté client : sans cette requête, le nom de l'école disparaît
  // au premier rechargement de page pour l'enseignant et le parent, qui
  // n'ont pas d'autre endroit où le lire.
  app.get('/me', requireAuth, requireRole(...ALL_ROLES), async (req, res) => {
    const school = await prisma.school.findUniqueOrThrow({
      where: { id: req.auth!.schoolId },
      select: { name: true },
    });
    res.json({ ...req.auth, schoolName: school.name });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
