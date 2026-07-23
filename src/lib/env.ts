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
  // Durée longue assumée : la révocation ne repose pas sur l'expiration mais
  // sur User.sessionsRevokedAt, vérifié à chaque requête authentifiée.
  ACCESS_TOKEN_TTL: z.string().default('30d'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  // Invitation d'un compte créé par l'admin : plus longue qu'une
  // réinitialisation, l'enseignant n'attend pas l'email devant son écran.
  INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(72),

  // Emails : MAILER=console n'envoie rien et n'entame aucun quota (défaut en dev)
  MAILER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('onboarding@resend.dev'),

  /** Racine publique de l'API elle-même. */
  APP_BASE_URL: z.string().default('http://localhost:3000'),

  /**
   * Racine de l'application web, celle que l'utilisateur ouvre dans son
   * navigateur.
   *
   * Les liens de réinitialisation et d'invitation doivent y pointer, pas sur
   * l'API : `GET /reset-password?token=…` n'existe pas côté serveur et
   * répondait 404 à chaque destinataire. Reprend `APP_BASE_URL` si absente,
   * pour ne pas casser les déploiements existants.
   */
  WEB_APP_URL: z.string().optional(),

  /**
   * Notifications push. PUSH=console n'envoie rien et trace le message.
   *
   * PUSH=fcm exige les identifiants du COMPTE DE SERVICE Firebase (Console →
   * Paramètres → Comptes de service → Générer une clé privée), pas la config
   * web du frontend : `apiKey` et clé VAPID vivent dans le navigateur et ne
   * permettent pas d'envoyer.
   */
  PUSH: z.enum(['console', 'fcm']).default('console'),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  /**
   * Nombre de reverse proxies devant l'application (0 = aucun).
   *
   * Doit rester à 0 tant que l'app est exposée directement : sinon Express
   * calcule `req.ip` depuis X-Forwarded-For, en-tête que n'importe quel client
   * peut forger, ce qui donne au bruteforce un compteur de rate-limit neuf à
   * chaque requête.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

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

/**
 * Racine de l'application web pour les liens envoyés par email.
 * Repli sur `APP_BASE_URL` tant que `WEB_APP_URL` n'est pas renseignée.
 */
export const webAppUrl = (env.WEB_APP_URL ?? env.APP_BASE_URL).replace(/\/+$/, '');
