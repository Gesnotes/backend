import { z } from 'zod';

/**
 * Schémas Zod pour la validation des entrées utilisateur.
 * Tous les messages sont en français clair, adaptés au public non-technique.
 */

// ========== Notifications (annonces, convocations, incidents) ==========

export const createNotificationSchema = z.object({
  title: z
    .string()
    .min(1, 'Le titre est requis')
    .max(200, 'Le titre ne peut pas dépasser 200 caractères'),
  body: z
    .string()
    .min(1, 'Le contenu est requis')
    .max(5000, 'Le contenu ne peut pas dépasser 5000 caractères'),
  type: z
    .string()
    .refine((val) => ['annonce', 'convocation', 'incident'].includes(val), {
      message: 'Le type doit être une annonce, une convocation ou un incident',
    })
    .transform((val) => val as 'annonce' | 'convocation' | 'incident'),
  severity: z.coerce
    .number()
    .int('La sévérité doit être un nombre entier')
    .min(0, 'La sévérité doit être au moins 0')
    .max(2, 'La sévérité doit être au maximum 2')
    .optional(),
  targetType: z
    .string()
    .refine((val) => ['parent', 'class_parents', 'school_parents'].includes(val), {
      message: 'Le type de cible doit être un parent, une classe ou toute l\'école',
    })
    .transform((val) => val as 'parent' | 'class_parents' | 'school_parents'),
  targetId: z.coerce
    .number()
    .int('L\'ID cible doit être un nombre entier')
    .positive('L\'ID cible doit être positif')
    .nullable()
    .optional(),
  resourceType: z
    .string()
    .refine((val) => val === null || ['grade', 'student', 'attendance', 'enrollment', 'other'].includes(val), {
      message: 'Le type de ressource est invalide',
    })
    .transform((val) => val as 'grade' | 'student' | 'attendance' | 'enrollment' | 'other' | null)
    .nullable()
    .optional(),
  resourceId: z.coerce
    .number()
    .int('L\'ID ressource doit être un nombre entier')
    .positive('L\'ID ressource doit être positif')
    .nullable()
    .optional(),
});

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;

export const markNotificationAsReadSchema = z.object({
  notificationId: z.coerce
    .number()
    .int('L\'ID notification doit être un nombre entier')
    .positive('L\'ID notification doit être positif'),
});

export type MarkNotificationAsReadInput = z.infer<typeof markNotificationAsReadSchema>;

export const listNotificationsQuerySchema = z.object({
  unread: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce
    .number()
    .int('La limite doit être un nombre entier')
    .min(1, 'La limite doit être au moins 1')
    .max(100, 'La limite ne peut pas dépasser 100')
    .default(20),
  offset: z.coerce
    .number()
    .int('Le décalage doit être un nombre entier')
    .min(0, 'Le décalage doit être au moins 0')
    .default(0),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
