import 'dotenv/config';

import { z } from 'zod';

/**
 * Validation de l'environnement au démarrage.
 *
 * Une variable manquante fait échouer le processus immédiatement, avec un
 * message explicite, plutôt que de produire une erreur incompréhensible à la
 * première requête (ou pire : un JWT signé avec `undefined`).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET doit faire au moins 32 caractères'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),

  // Emails : MAILER=console n'envoie rien et n'entame aucun quota (défaut en dev)
  MAILER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('onboarding@resend.dev'),

  APP_BASE_URL: z.string().default('http://localhost:3000'),

  // Repli de sous-domaine hors production : en local, req.hostname vaut
  // "localhost" et ne résout aucune école (cf. plan §6.5).
  DEFAULT_SCHOOL_SUBDOMAIN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Configuration d'environnement invalide :\n${details}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
