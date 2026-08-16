import { Router } from 'express';
import { z } from 'zod';

import * as authService from '../services/auth.service';
import { credentialsLimiter, sessionLimiter } from '../middlewares/rateLimit';
import { publicRoute } from '../middlewares/publicRoute';
import { requireAuth } from '../middlewares/requireAuth';
import { ALL_ROLES, requireRole } from '../middlewares/requireRole';
import { validate } from '../middlewares/validate';

export const authRoutes = Router();

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

const forgotSchema = z.object({ email: z.email() });

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères'),
});

const linkAccountSchema = z.object({
  identifier: z.string().min(1, 'Email ou téléphone requis'),
  password: z.string().min(1, 'Mot de passe requis'),
});

authRoutes.post('/refresh', publicRoute,
  sessionLimiter, validate({ body: refreshSchema }), async (req, res) => {
  const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
  res.json(await authService.refresh(refreshToken));
});

authRoutes.post('/logout', publicRoute,
  sessionLimiter, validate({ body: refreshSchema }), async (req, res) => {
  const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
  await authService.logout(refreshToken, req.auth?.userId);
  res.status(204).send();
});

authRoutes.post(
  '/forgot-password',
  publicRoute,
  credentialsLimiter,
  validate({ body: forgotSchema }),
  async (req, res) => {
    const { email } = req.body as z.infer<typeof forgotSchema>;
    await authService.requestPasswordReset(email);

    // Réponse identique que le compte existe ou non : pas d'énumération.
    res.json({ message: 'Si un compte existe, un email de réinitialisation a été envoyé.' });
  },
);

authRoutes.post(
  '/reset-password',
  publicRoute,
  credentialsLimiter,
  validate({ body: resetSchema }),
  async (req, res) => {
    const { token, password } = req.body as z.infer<typeof resetSchema>;
    await authService.resetPassword(token, password);
    res.json({ message: 'Mot de passe mis à jour.' });
  },
);

/**
 * Lie le compte courant à un second compte (identifiants différents) de la
 * même personne réelle — ex. un enseignant qui est aussi parent dans la même
 * école. `credentialsLimiter` : cette route vérifie un mot de passe, comme
 * `/identify`, et doit être protégée du même brute-force.
 */
authRoutes.post(
  '/link-account',
  requireAuth,
  requireRole(...ALL_ROLES),
  credentialsLimiter,
  validate({ body: linkAccountSchema }),
  async (req, res) => {
    const { identifier, password } = req.body as z.infer<typeof linkAccountSchema>;
    res.json(await authService.linkAccount(req.auth!, identifier, password));
  },
);
