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
 * Réservée à l'administration et aux enseignants, comme /teachers/me/grades.
 * Classe (mode `presence`) ou créneau (mode `notes`), jamais les deux — le
 * tri fin (admin, référent, ou enseignant du créneau selon le cas) est fait
 * dans le service, par `assertCanTakeAttendanceForClass`/`ForSlot`.
 */
export const attendanceMeRoutes = Router();

attendanceMeRoutes.use(requireAuth, requireRole('teacher', 'admin'));

const targetXor = { message: 'Indiquez la classe ou le créneau, pas les deux.' };

const sheetQuery = z
  .object({
    class_id: z.coerce.number().int().positive().optional(),
    slot_id: z.coerce.number().int().positive().optional(),
    date: z.iso.date(),
  })
  .refine((q) => (q.class_id === undefined) !== (q.slot_id === undefined), targetXor);

/**
 * Une classe (ou un créneau) entière tient dans un lot, comme la saisie des
 * notes. `status` à `null` efface l'enregistrement du jour pour cet élève.
 */
const batchBody = z
  .object({
    classId: z.coerce.number().int().positive().optional(),
    slotId: z.coerce.number().int().positive().optional(),
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
  })
  .refine((b) => (b.classId === undefined) !== (b.slotId === undefined), targetXor);

/** Feuille de présence d'une classe ou d'un créneau pour un jour : tous ses élèves, chacun avec son statut (ou aucun). */
attendanceMeRoutes.get('/attendance', validate({ query: sheetQuery }), async (req, res) => {
  const { class_id, slot_id, date } = req.query as unknown as z.infer<typeof sheetQuery>;
  res.json(
    await attendanceService.getAttendanceSheet(authOf(req), { classId: class_id, slotId: slot_id }, date),
  );
});

/**
 * Saisie d'une journée entière. `PUT`, comme la saisie des notes : idempotent,
 * décrit l'état voulu de la présence du jour pour la classe (ou le créneau).
 */
attendanceMeRoutes.put('/attendance', validate({ body: batchBody }), async (req, res) => {
  const data = req.body as z.infer<typeof batchBody>;
  res.json(await attendanceService.saveAttendanceBatch(authOf(req), data));
});
