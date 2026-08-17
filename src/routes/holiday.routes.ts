import { Router } from 'express';
import { z } from 'zod';

import * as holidayService from '../services/holiday.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const holidayRoutes = Router();

/** Calendrier scolaire : réservé à l'administration, comme les autres référentiels de gestion. */
holidayRoutes.use(requireAuth, requireRole('admin'));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const boolFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const listQuery = z.object({ include_archived: boolFlag });

/**
 * `permanent` efface le jour férié pour de bon ; sans le drapeau, il est
 * seulement archivé. Le libellé exact est exigé, comme pour les autres
 * suppressions définitives de l'application.
 */
const deleteQuery = z.object({
  permanent: boolFlag,
  confirm_label: z.string().optional(),
});

const createBody = z.object({
  date: z.iso.date(),
  label: z.string().trim().min(1).max(150),
});

const updateBody = createBody
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

holidayRoutes.get('/', validate({ query: listQuery }), async (req, res) => {
  const { include_archived } = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await holidayService.listHolidays(schoolIdOf(req), include_archived));
});

holidayRoutes.post('/', validate({ body: createBody }), async (req, res) => {
  const data = req.body as z.infer<typeof createBody>;
  res.status(201).json(await holidayService.createHoliday(schoolIdOf(req), data));
});

holidayRoutes.patch(
  '/:id',
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await holidayService.updateHoliday(schoolIdOf(req), id, data));
  },
);

holidayRoutes.delete(
  '/:id',
  validate({ params: idParam, query: deleteQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { permanent, confirm_label } = req.query as unknown as z.infer<typeof deleteQuery>;

    if (permanent) {
      await holidayService.deleteHolidayPermanently(schoolIdOf(req), id, confirm_label ?? '');
    } else {
      await holidayService.archiveHoliday(schoolIdOf(req), id);
    }
    res.status(204).send();
  },
);

holidayRoutes.post(
  '/:id/restore',
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    res.json(await holidayService.restoreHoliday(schoolIdOf(req), id));
  },
);
