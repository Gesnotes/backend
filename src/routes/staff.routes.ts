import { Router } from 'express';
import { z } from 'zod';

import * as staffAuthService from '../services/staff-auth.service';
import * as staffService from '../services/staff.service';
import { requireStaffAuth } from '../middlewares/requireStaffAuth';
import { credentialsLimiter, sessionLimiter } from '../middlewares/rateLimit';
import { publicRoute } from '../middlewares/publicRoute';
import { validate } from '../middlewares/validate';

/**
 * Espace de l'équipe Gesnotes : supervision de la plateforme, traitement des
 * demandes d'inscription. Monté avant `schoolContext` dans `app.ts` — aucune
 * école n'est concernée par ces routes, `requireStaffAuth` fait tout le
 * travail d'authentification à lui seul (voir son commentaire).
 */
export const staffRoutes = Router();

const loginBody = z.object({
  email: z.email('Email invalide'),
  password: z.string().min(1, 'Mot de passe requis'),
});

const refreshBody = z.object({ refreshToken: z.string().min(1) });

const forgotBody = z.object({ email: z.email('Email invalide') });

const resetBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères'),
});

staffRoutes.post(
  '/login',
  publicRoute,
  credentialsLimiter,
  validate({ body: loginBody }),
  async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginBody>;
    res.json(await staffAuthService.login(email, password));
  },
);

staffRoutes.post(
  '/refresh',
  publicRoute,
  sessionLimiter,
  validate({ body: refreshBody }),
  async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshBody>;
    res.json(await staffAuthService.refresh(refreshToken));
  },
);

staffRoutes.post(
  '/logout',
  publicRoute,
  sessionLimiter,
  validate({ body: refreshBody }),
  async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshBody>;
    await staffAuthService.logout(refreshToken);
    res.status(204).send();
  },
);

staffRoutes.post(
  '/forgot-password',
  publicRoute,
  credentialsLimiter,
  validate({ body: forgotBody }),
  async (req, res) => {
    const { email } = req.body as z.infer<typeof forgotBody>;
    await staffAuthService.requestPasswordReset(email);

    // Réponse identique que le compte existe ou non : pas d'énumération.
    res.json({ message: 'Si un compte existe, un email de réinitialisation a été envoyé.' });
  },
);

staffRoutes.post(
  '/reset-password',
  publicRoute,
  credentialsLimiter,
  validate({ body: resetBody }),
  async (req, res) => {
    const { token, password } = req.body as z.infer<typeof resetBody>;
    await staffAuthService.resetPassword(token, password);
    res.json({ message: 'Mot de passe mis à jour.' });
  },
);

staffRoutes.get('/me', requireStaffAuth, (req, res) => {
  res.json(req.staffAuth);
});

staffRoutes.get('/overview', requireStaffAuth, async (_req, res) => {
  res.json(await staffService.getOverview());
});

staffRoutes.get('/schools', requireStaffAuth, async (_req, res) => {
  res.json(await staffService.listSchoolsWithMetrics());
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const statusQuery = z.object({
  status: z.enum(['nouveau', 'traite']).optional(),
});

staffRoutes.get(
  '/signup-requests',
  requireStaffAuth,
  validate({ query: statusQuery }),
  async (req, res) => {
    const { status } = req.query as unknown as z.infer<typeof statusQuery>;
    res.json(await staffService.listSignupRequests(status));
  },
);

const acceptBody = z.object({
  schoolName: z.string().trim().min(1).max(150).optional(),
  city: z.string().trim().min(1).max(100).optional(),
});

staffRoutes.post(
  '/signup-requests/:id/accept',
  requireStaffAuth,
  validate({ params: idParam, body: acceptBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof acceptBody>;
    res.status(201).json(await staffService.acceptSignupRequest(id, data));
  },
);

staffRoutes.post(
  '/signup-requests/:id/decline',
  requireStaffAuth,
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    await staffService.declineSignupRequest(id);
    res.status(204).send();
  },
);

const boolFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

/**
 * `permanent` supprime l'école et tout ce qu'elle contient ; sans le
 * drapeau, elle est seulement suspendue. La suppression définitive exige le
 * nom exact de l'école, comme pour une période ou une année scolaire.
 */
const deleteSchoolQuery = z.object({
  permanent: boolFlag,
  confirm_label: z.string().optional(),
});

staffRoutes.delete(
  '/schools/:id',
  requireStaffAuth,
  validate({ params: idParam, query: deleteSchoolQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { permanent, confirm_label } = req.query as unknown as z.infer<typeof deleteSchoolQuery>;

    if (permanent) {
      await staffService.deleteSchoolPermanently(id, confirm_label ?? '');
    } else {
      await staffService.suspendSchool(id);
    }
    res.status(204).send();
  },
);

staffRoutes.post(
  '/schools/:id/restore',
  requireStaffAuth,
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    await staffService.restoreSchool(id);
    res.status(204).send();
  },
);

/** Renvoie l'invitation au compte administrateur de l'école (email perdu, lien expiré). */
staffRoutes.post(
  '/schools/:id/invitation',
  requireStaffAuth,
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    await staffService.resendAdminInvitation(id);
    res.json({ message: 'Invitation envoyée.' });
  },
);
