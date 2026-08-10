import { Router } from 'express';
import { z } from 'zod';

import * as subjectService from '../services/subject.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const subjectRoutes = Router();

// Les matières sont administrées par l'admin ; les enseignants les consultent.
// Un parent n'y a pas accès : la liste porte les affectations de l'équipe.
subjectRoutes.use(requireAuth);

const idParam = z.object({ id: z.coerce.number().int().positive() });

const coefficientParams = z.object({
  id: z.coerce.number().int().positive(),
  classId: z.coerce.number().int().positive(),
});

const listQuery = z.object({
  include_archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  coefficient: z.coerce.number().positive().max(99.99).optional(),
});

const updateBody = createBody.partial().refine((data) => Object.keys(data).length > 0, {
  message: 'Aucun champ à modifier',
});

const coefficientBody = z.object({
  coefficient: z.coerce.number().positive().max(99.99),
});

const deleteQuery = z.object({
  permanent: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  confirm_label: z.string().optional(),
});

subjectRoutes.get('/', requireRole('admin', 'teacher'), validate({ query: listQuery }), async (req, res) => {
  const { include_archived } = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await subjectService.listSubjects(schoolIdOf(req), include_archived));
});

subjectRoutes.post(
  '/',
  requireRole('admin'),
  validate({ body: createBody }),
  async (req, res) => {
    const data = req.body as z.infer<typeof createBody>;
    res.status(201).json(await subjectService.createSubject(schoolIdOf(req), data));
  },
);

subjectRoutes.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await subjectService.updateSubject(schoolIdOf(req), id, data));
  },
);

subjectRoutes.delete(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, query: deleteQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { permanent, confirm_label } = req.query as unknown as z.infer<typeof deleteQuery>;
    await subjectService.deleteSubject(schoolIdOf(req), id, permanent, confirm_label ?? '');
    res.status(204).send();
  },
);

subjectRoutes.post(
  '/:id/restore',
  requireRole('admin'),
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    res.json(await subjectService.restoreSubject(schoolIdOf(req), id));
  },
);

subjectRoutes.put(
  '/:id/coefficients/:classId',
  requireRole('admin'),
  validate({ params: coefficientParams, body: coefficientBody }),
  async (req, res) => {
    const { id, classId } = req.params as unknown as z.infer<typeof coefficientParams>;
    const { coefficient } = req.body as z.infer<typeof coefficientBody>;
    res.json(
      await subjectService.setSubjectCoefficient(schoolIdOf(req), id, classId, coefficient),
    );
  },
);

subjectRoutes.delete(
  '/:id/coefficients/:classId',
  requireRole('admin'),
  validate({ params: coefficientParams }),
  async (req, res) => {
    const { id, classId } = req.params as unknown as z.infer<typeof coefficientParams>;
    await subjectService.removeSubjectCoefficient(schoolIdOf(req), id, classId);
    res.status(204).send();
  },
);
