import { Router } from 'express';
import { z } from 'zod';

import * as gradeTypeService from '../services/gradeType.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const gradeTypeRoutes = Router();

/**
 * Réservé à l'équipe pédagogique : ce référentiel sert à saisir des notes.
 * Le parent reçoit déjà la catégorie de chaque note dans `/children/:id/grades`
 * et n'a pas besoin de la liste complète. L'écriture (création, modification,
 * archivage) reste à l'administration — c'est elle qui décide comment
 * l'école catégorise ses évaluations.
 */
gradeTypeRoutes.use(requireAuth, requireRole('admin', 'teacher'));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const boolFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const listQuery = z.object({ include_archived: boolFlag });

const createBody = z.object({
  label: z.string().trim().min(1).max(50),
  weight: z.coerce.number().positive().max(99.99),
  required: z.boolean(),
});

const updateBody = createBody
  .partial()
  .extend({ position: z.coerce.number().int().min(0).optional() })
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

/**
 * `permanent` efface le type de note pour de bon ; sans le drapeau, il est
 * seulement archivé. La suppression définitive exige le libellé exact, et
 * échoue s'il reste des notes ou évaluations qui le référencent (voir
 * `gradeType.service.ts::deleteGradeTypePermanently`).
 */
const deleteQuery = z.object({
  permanent: boolFlag,
  confirm_label: z.string().optional(),
});

gradeTypeRoutes.get('/', validate({ query: listQuery }), async (req, res) => {
  const { include_archived } = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await gradeTypeService.listGradeTypes(schoolIdOf(req), include_archived));
});

gradeTypeRoutes.post(
  '/',
  requireRole('admin'),
  validate({ body: createBody }),
  async (req, res) => {
    const data = req.body as z.infer<typeof createBody>;
    res.status(201).json(await gradeTypeService.createGradeType(schoolIdOf(req), data));
  },
);

gradeTypeRoutes.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await gradeTypeService.updateGradeType(schoolIdOf(req), id, data));
  },
);

gradeTypeRoutes.delete(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, query: deleteQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { permanent, confirm_label } = req.query as unknown as z.infer<typeof deleteQuery>;

    if (permanent) {
      await gradeTypeService.deleteGradeTypePermanently(schoolIdOf(req), id, confirm_label ?? '');
    } else {
      await gradeTypeService.archiveGradeType(schoolIdOf(req), id);
    }
    res.status(204).send();
  },
);

gradeTypeRoutes.post(
  '/:id/restore',
  requireRole('admin'),
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    res.json(await gradeTypeService.restoreGradeType(schoolIdOf(req), id));
  },
);
