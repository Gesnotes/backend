import { Router } from 'express';
import { z } from 'zod';

import * as attendanceService from '../services/attendance.service';
import * as bulletinService from '../services/bulletin/bulletin.service';
import * as notificationService from '../services/notification.service';
import * as parentService from '../services/parent.service';
import { authOf } from '../lib/requestContext';
import { notFound } from '../errors/AppError';
import { requireAuth } from '../middlewares/requireAuth';
import { ALL_ROLES, requireRole } from '../middlewares/requireRole';
import { validate } from '../middlewares/validate';

/** /parents/me — espace du parent connecté. */
export const parentMeRoutes = Router();
/** /children/:id — consultable par le parent, le prof de la classe et l'admin. */
export const childrenRoutes = Router();
/** /grades/:id en lecture — parent ET professeur. */
export const gradeDetailRoutes = Router();

parentMeRoutes.use(requireAuth, requireRole('parent'));
// Le cloisonnement fin (parent de l'élève, professeur de sa classe) est fait
// par `assertIsParentOf` dans le service ; le rôle reste déclaré ici pour que
// chaque route porte explicitement qui a le droit de lire.
childrenRoutes.use(requireAuth, requireRole(...ALL_ROLES));
gradeDetailRoutes.use(requireAuth, requireRole(...ALL_ROLES));

const idParam = z.object({ id: z.coerce.number().int().positive() });
const termQuery = z.object({ term_id: z.coerce.number().int().positive() });
const schoolYearQuery = z.object({ school_year_id: z.coerce.number().int().positive() });
const optionalTermQuery = z.object({
  term_id: z.coerce.number().int().positive().optional(),
  subject_id: z.coerce.number().int().positive().optional(),
});

parentMeRoutes.get('/children', validate({ query: optionalTermQuery }), async (req, res) => {
  const { term_id } = req.query as unknown as z.infer<typeof optionalTermQuery>;
  res.json(await parentService.listMyChildren(authOf(req), term_id));
});

const deviceBody = z.object({ fcmToken: z.string().trim().min(10).max(255) });
const deviceParams = z.object({ deviceToken: z.string().trim().min(10).max(255) });

/** Enregistre un appareil pour recevoir les notifications push. */
parentMeRoutes.post('/devices', validate({ body: deviceBody }), async (req, res) => {
  const { fcmToken } = req.body as z.infer<typeof deviceBody>;
  const device = await notificationService.registerDevice(authOf(req).userId, fcmToken);
  res.status(201).json({ id: device.id, createdAt: device.createdAt });
});

parentMeRoutes.get('/devices', async (req, res) => {
  res.json(await notificationService.listDevices(authOf(req).userId));
});

/** Retire un appareil (déconnexion, changement de téléphone). */
parentMeRoutes.delete('/devices/:deviceToken', validate({ params: deviceParams }), async (req, res) => {
  const { deviceToken } = req.params as unknown as z.infer<typeof deviceParams>;
  const removed = await notificationService.removeDevice(authOf(req).userId, deviceToken);
  if (!removed) throw notFound('Appareil introuvable');
  res.status(204).send();
});

childrenRoutes.get(
  '/:id',
  validate({ params: idParam, query: termQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { term_id } = req.query as unknown as z.infer<typeof termQuery>;
    res.json(await parentService.getChildDetail(authOf(req), id, term_id));
  },
);

/**
 * Bulletin PDF d'un seul enfant.
 *
 * Hors spec initiale : un parent qui conteste une moyenne demande cette pièce,
 * et lui faire télécharger le tableau de la classe exposerait les résultats
 * des autres enfants.
 */
childrenRoutes.get(
  '/:id/bulletin/export',
  validate({ params: idParam, query: termQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { term_id } = req.query as unknown as z.infer<typeof termQuery>;

    const file = await bulletinService.exportStudentBulletin(authOf(req), id, term_id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Length', String(file.buffer.length));
    res.send(file.buffer);
  },
);

/** Bulletin annuel cumulé d'un seul enfant — pendant annuel de l'export ci-dessus. */
childrenRoutes.get(
  '/:id/bulletin/annual/export',
  validate({ params: idParam, query: schoolYearQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { school_year_id } = req.query as unknown as z.infer<typeof schoolYearQuery>;

    const file = await bulletinService.exportStudentAnnualBulletin(authOf(req), id, school_year_id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Length', String(file.buffer.length));
    res.send(file.buffer);
  },
);

childrenRoutes.get(
  '/:id/grades',
  validate({ params: idParam, query: optionalTermQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { term_id, subject_id } = req.query as unknown as z.infer<typeof optionalTermQuery>;
    res.json(
      await parentService.listChildGrades(authOf(req), id, {
        termId: term_id,
        subjectId: subject_id,
      }),
    );
  },
);

gradeDetailRoutes.get('/:id', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  res.json(await parentService.getGradeDetail(authOf(req), id));
});

const attendanceHistoryQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

/** Emploi du temps de la classe de l'enfant — matière et horaire, pas seulement présent/absent. */
childrenRoutes.get('/:id/schedule', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  res.json(await parentService.getChildSchedule(authOf(req), id));
});

childrenRoutes.get(
  '/:id/attendance',
  validate({ params: idParam, query: attendanceHistoryQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { from, to } = req.query as unknown as z.infer<typeof attendanceHistoryQuery>;
    res.json(await attendanceService.listChildAttendance(authOf(req), id, { from, to }));
  },
);
