import { Router } from 'express';
import { z } from 'zod';

import * as schoolYearService from '../services/schoolYear.service';
import { requireAuth } from '../middlewares/requireAuth';
import { ALL_ROLES, requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const schoolYearRoutes = Router();

/**
 * Lecture ouverte aux trois rôles, comme `/terms` : un libellé et deux dates,
 * aucune donnée nominative. L'écriture reste à l'administration.
 */
schoolYearRoutes.use(requireAuth, requireRole(...ALL_ROLES));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const boolFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const listQuery = z.object({ include_archived: boolFlag });

/**
 * `permanent` efface l'année ; sans le drapeau, elle est seulement archivée.
 * La suppression définitive exige le libellé exact.
 */
const deleteQuery = z.object({
  permanent: boolFlag,
  confirm_label: z.string().optional(),
});

const createBody = z.object({
  label: z.string().trim().min(1).max(50),
  startDate: z.iso.date().nullable().optional(),
  endDate: z.iso.date().nullable().optional(),
});

const updateBody = createBody
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

schoolYearRoutes.get('/', validate({ query: listQuery }), async (req, res) => {
  const { include_archived } = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await schoolYearService.listSchoolYears(schoolIdOf(req), include_archived));
});

schoolYearRoutes.get('/:id', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  res.json(await schoolYearService.getSchoolYear(schoolIdOf(req), id));
});

schoolYearRoutes.post(
  '/',
  requireRole('admin'),
  validate({ body: createBody }),
  async (req, res) => {
    const data = req.body as z.infer<typeof createBody>;
    res.status(201).json(await schoolYearService.createSchoolYear(schoolIdOf(req), data));
  },
);

schoolYearRoutes.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await schoolYearService.updateSchoolYear(schoolIdOf(req), id, data));
  },
);

schoolYearRoutes.delete(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, query: deleteQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { permanent, confirm_label } = req.query as unknown as z.infer<typeof deleteQuery>;

    if (permanent) {
      await schoolYearService.deleteSchoolYearPermanently(schoolIdOf(req), id, confirm_label ?? '');
    } else {
      await schoolYearService.archiveSchoolYear(schoolIdOf(req), id);
    }
    res.status(204).send();
  },
);

schoolYearRoutes.post(
  '/:id/restore',
  requireRole('admin'),
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    res.json(await schoolYearService.restoreSchoolYear(schoolIdOf(req), id));
  },
);
