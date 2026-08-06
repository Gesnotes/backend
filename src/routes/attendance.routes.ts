import { Router } from 'express';
import { z } from 'zod';

import * as attendanceService from '../services/attendance.service';
import { authOf } from '../lib/requestContext';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validate } from '../middlewares/validate';

/**
 * /teachers/me/attendance — saisie de la présence.
 *
 * Réservée à l'administration et aux enseignants, comme /teachers/me/grades ;
 * le tri fin (admin ou seul l'enseignant référent de la classe) est fait dans
 * le service, par `assertCanTakeAttendance`.
 */
export const attendanceMeRoutes = Router();

attendanceMeRoutes.use(requireAuth, requireRole('teacher', 'admin'));

const sheetQuery = z.object({
  class_id: z.coerce.number().int().positive(),
  date: z.iso.date(),
});

/**
 * Une classe entière tient dans un lot, comme la saisie des notes. `status`
 * à `null` efface l'enregistrement du jour pour cet élève.
 */
const batchBody = z.object({
  classId: z.coerce.number().int().positive(),
  date: z.iso.date(),
  entries: z
    .array(
      z.object({
        studentId: z.coerce.number().int().positive(),
        status: z.enum(['present', 'absent', 'late']).nullable(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .min(1)
    .max(300),
});

/** Feuille de présence d'une classe pour un jour : tous ses élèves, chacun avec son statut (ou aucun). */
attendanceMeRoutes.get('/attendance', validate({ query: sheetQuery }), async (req, res) => {
  const { class_id, date } = req.query as unknown as z.infer<typeof sheetQuery>;
  res.json(await attendanceService.getAttendanceSheet(authOf(req), class_id, date));
});

/**
 * Saisie d'une journée entière. `PUT`, comme la saisie des notes : idempotent,
 * décrit l'état voulu de la présence du jour pour la classe.
 */
attendanceMeRoutes.put('/attendance', validate({ body: batchBody }), async (req, res) => {
  const data = req.body as z.infer<typeof batchBody>;
  res.json(await attendanceService.saveAttendanceBatch(authOf(req), data));
});
