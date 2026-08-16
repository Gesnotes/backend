import { Router } from 'express';
import { z } from 'zod';

import * as scheduleService from '../services/schedule.service';
import { hhmmToMinutes } from '../services/schedule.service';
import { authOf, schoolIdOf } from '../lib/requestContext';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validate } from '../middlewares/validate';

/**
 * /classes/:id/schedule — emploi du temps d'une classe.
 *
 * Lecture ouverte à l'admin et aux enseignants (restreinte à leurs propres
 * classes en service, voir `assertCanViewSchedule`) ; toute écriture est
 * réservée à l'administration, comme la gestion des affectations dont ce
 * créneau dépend (voir teacher.routes.ts).
 */
export const scheduleRoutes = Router();

scheduleRoutes.use(requireAuth, requireRole('admin', 'teacher'));

const idParam = z.object({ id: z.coerce.number().int().positive() });
const slotIdParam = z.object({ id: z.coerce.number().int().positive(), slotId: z.coerce.number().int().positive() });

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const weekday = z.enum(['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'], {
  message: 'Le jour doit être un jour de la semaine.',
});

const timeField = (field: string) =>
  z
    .string({ message: `${field} est obligatoire.` })
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${field} doit être au format HH:MM.`);

const listQuery = z.object({ include_archived: boolFlag });

const createBody = z.object({
  teacherAssignmentId: z.coerce.number().int().positive(),
  dayOfWeek: weekday,
  startTime: timeField('L’heure de début'),
  endTime: timeField('L’heure de fin'),
});

const updateBody = z
  .object({
    teacherAssignmentId: z.coerce.number().int().positive().optional(),
    dayOfWeek: weekday.optional(),
    startTime: timeField('L’heure de début').optional(),
    endTime: timeField('L’heure de fin').optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

const deleteQuery = z.object({ permanent: boolFlag, confirm_label: z.string().optional() });

scheduleRoutes.get('/:id/schedule', validate({ params: idParam, query: listQuery }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  const { include_archived } = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await scheduleService.listSlotsForClass(authOf(req), id, include_archived));
});

scheduleRoutes.post(
  '/:id/schedule',
  requireRole('admin'),
  validate({ params: idParam, body: createBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { teacherAssignmentId, dayOfWeek, startTime, endTime } = req.body as z.infer<typeof createBody>;
    res.status(201).json(
      await scheduleService.createSlot(schoolIdOf(req), id, {
        teacherAssignmentId,
        dayOfWeek,
        startMinute: hhmmToMinutes(startTime),
        endMinute: hhmmToMinutes(endTime),
      }),
    );
  },
);

scheduleRoutes.patch(
  '/:id/schedule/:slotId',
  requireRole('admin'),
  validate({ params: slotIdParam, body: updateBody }),
  async (req, res) => {
    const { id, slotId } = req.params as unknown as z.infer<typeof slotIdParam>;
    const { teacherAssignmentId, dayOfWeek, startTime, endTime } = req.body as z.infer<typeof updateBody>;
    res.json(
      await scheduleService.updateSlot(schoolIdOf(req), id, slotId, {
        teacherAssignmentId,
        dayOfWeek,
        ...(startTime !== undefined ? { startMinute: hhmmToMinutes(startTime) } : {}),
        ...(endTime !== undefined ? { endMinute: hhmmToMinutes(endTime) } : {}),
      }),
    );
  },
);

scheduleRoutes.delete(
  '/:id/schedule/:slotId',
  requireRole('admin'),
  validate({ params: slotIdParam, query: deleteQuery }),
  async (req, res) => {
    const { id, slotId } = req.params as unknown as z.infer<typeof slotIdParam>;
    const { permanent, confirm_label } = req.query as unknown as z.infer<typeof deleteQuery>;

    if (permanent) {
      await scheduleService.deleteSlotPermanently(schoolIdOf(req), id, slotId, confirm_label ?? '');
    } else {
      await scheduleService.archiveSlot(schoolIdOf(req), id, slotId);
    }
    res.status(204).send();
  },
);

scheduleRoutes.post(
  '/:id/schedule/:slotId/restore',
  requireRole('admin'),
  validate({ params: slotIdParam }),
  async (req, res) => {
    const { id, slotId } = req.params as unknown as z.infer<typeof slotIdParam>;
    res.json(await scheduleService.restoreSlot(schoolIdOf(req), id, slotId));
  },
);
