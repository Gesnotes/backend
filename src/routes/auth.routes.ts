import { Router } from 'express';
import { z } from 'zod';

import * as authService from '../services/auth.service';
import { badRequest } from '../errors/AppError';
import { credentialsLimiter, sessionLimiter } from '../middlewares/rateLimit';
import { validate } from '../middlewares/validate';

export const authRoutes = Router();

const loginSchema = z.object({
  identifier: z.string().min(1, 'Email ou téléphone requis'),
  password: z.string().min(1, 'Mot de passe requis'),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

const forgotSchema = z.object({ email: z.email() });

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères'),
});

authRoutes.post('/login', credentialsLimiter, validate({ body: loginSchema }), async (req, res) => {
  if (!req.schoolId) throw badRequest('École non résolue');
  const { identifier, password } = req.body as z.infer<typeof loginSchema>;
  res.json(await authService.login(req.schoolId, identifier, password));
});

authRoutes.post('/refresh', sessionLimiter, validate({ body: refreshSchema }), async (req, res) => {
  const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
  res.json(await authService.refresh(refreshToken));
});

authRoutes.post('/logout', sessionLimiter, validate({ body: refreshSchema }), async (req, res) => {
  const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
  await authService.logout(refreshToken, req.auth?.userId);
  res.status(204).send();
});

authRoutes.post(
  '/forgot-password',
  credentialsLimiter,
  validate({ body: forgotSchema }),
  async (req, res) => {
    if (!req.schoolId) throw badRequest('École non résolue');
    const { email } = req.body as z.infer<typeof forgotSchema>;
    await authService.requestPasswordReset(req.schoolId, email);

    // Réponse identique que le compte existe ou non : pas d'énumération.
    res.json({ message: 'Si un compte existe, un email de réinitialisation a été envoyé.' });
  },
);

authRoutes.post(
  '/reset-password',
  credentialsLimiter,
  validate({ body: resetSchema }),
  async (req, res) => {
    const { token, password } = req.body as z.infer<typeof resetSchema>;
    await authService.resetPassword(token, password);
    res.json({ message: 'Mot de passe mis à jour.' });
  },
);
