import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validate } from '../middlewares/validate';
import {
  createNotification,
  listNotificationsForParent,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  listSentNotifications,
} from '../services/notification.service';
import {
  createNotificationSchema,
  listNotificationsQuerySchema,
  type CreateNotificationInput,
  type ListNotificationsQuery,
} from '../lib/validationSchemas';
import { notFound, forbidden } from '../errors/AppError';
import prisma from '../lib/prisma';

const router = Router();

/**
 * POST /notifications
 * Créer une nouvelle notification (annonce, convocation, incident)
 * Requis: admin ou enseignant
 */
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'teacher'),
  validate({ body: createNotificationSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = req.body as CreateNotificationInput;
      const auth = req.auth!;

      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
      });

      if (!user || user.schoolId !== auth.schoolId) {
        throw forbidden('Accès refusé');
      }

      const severity =
        input.severity ??
        (input.type === 'incident' ? 2 : input.type === 'convocation' ? 1 : 0);

      const result = await createNotification({
        schoolId: auth.schoolId,
        creatorUserId: auth.userId,
        title: input.title,
        body: input.body,
        type: input.type,
        severity,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /notifications
 * Lister les notifications du parent connecté
 * Filtres: ?unread=true&limit=20&offset=0
 * Requis: parent
 */
router.get(
  '/',
  requireAuth,
  requireRole('parent'),
  validate({ query: listNotificationsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { unread, limit, offset } = req.query as unknown as ListNotificationsQuery;
      const auth = req.auth!;

      const result = await listNotificationsForParent(auth.userId, auth.schoolId, {
        unreadOnly: unread ?? false,
        limit: limit ?? 20,
        offset: offset ?? 0,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /notifications/sent
 * Lister les notifications envoyées par l'école ou l'enseignant
 * Requis: admin ou enseignant
 */
router.get(
  '/sent',
  requireAuth,
  requireRole('admin', 'teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.auth!;
      const items = await listSentNotifications(auth.schoolId, auth.userId, auth.role);

      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PATCH /notifications/:id/read
 * Marquer une notification comme lue
 * Requis: parent
 */
router.patch(
  '/:id/read',
  requireAuth,
  requireRole('parent'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const notificationId = parseInt(req.params.id as string, 10);
      if (isNaN(notificationId)) {
        throw notFound('Notification non trouvée');
      }

      const auth = req.auth!;
      const success = await markNotificationAsRead(notificationId, auth.userId, auth.schoolId);

      if (!success) {
        throw notFound("Notification non trouvée ou pas d'accès");
      }

      res.json({ success: true, message: 'Notification marquée comme lue' });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /notifications/read-all
 * Marquer TOUTES les notifications comme lues
 * Requis: parent
 */
router.post(
  '/read-all',
  requireAuth,
  requireRole('parent'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.auth!;
      const count = await markAllNotificationsAsRead(auth.userId, auth.schoolId);

      res.json({ success: true, count, message: 'Toutes les notifications ont été marquées comme lues' });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
