import { Router } from 'express';
import { z } from 'zod';

import * as evaluationService from '../services/evaluation.service';
import { authOf } from '../lib/requestContext';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validate } from '../middlewares/validate';

/** Liste et création, contextualisées à l'enseignant : montées sous /teachers/me. */
export const evaluationMeRoutes = Router();
/** Modification et suppression d'une évaluation par son id : montées sous /evaluations. */
export const evaluationRoutes = Router();

evaluationMeRoutes.use(requireAuth, requireRole('teacher', 'admin'));
evaluationRoutes.use(requireAuth, requireRole('teacher', 'admin'));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = z.object({
  class_id: z.coerce.number().int().positive(),
  subject_id: z.coerce.number().int().positive(),
  term_id: z.coerce.number().int().positive(),
});

// La date est une date simple (jour du contrôle), pas un instant : format ISO
// `AAAA-MM-JJ`, ou `null` pour l'effacer.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');

const createBody = z.object({
  classId: z.coerce.number().int().positive(),
  subjectId: z.coerce.number().int().positive(),
  gradeTypeId: z.coerce.number().int().positive(),
  termId: z.coerce.number().int().positive(),
  label: z.string().trim().min(1).max(120),
  date: isoDate.nullable().optional(),
  maxValue: z.coerce.number().positive().optional(),
});

const updateBody = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    date: isoDate.nullable().optional(),
    maxValue: z.coerce.number().positive().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

evaluationMeRoutes.get('/evaluations', validate({ query: listQuery }), async (req, res) => {
  const { class_id, subject_id, term_id } = req.query as unknown as z.infer<typeof listQuery>;
  res.json(
    await evaluationService.listEvaluations(authOf(req), {
      classId: class_id,
      subjectId: subject_id,
      termId: term_id,
    }),
  );
});

evaluationMeRoutes.post('/evaluations', validate({ body: createBody }), async (req, res) => {
  const data = req.body as z.infer<typeof createBody>;
  res.status(201).json(await evaluationService.createEvaluation(authOf(req), data));
});

evaluationRoutes.patch(
  '/:id',
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await evaluationService.updateEvaluation(authOf(req), id, data));
  },
);

evaluationRoutes.delete('/:id', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  await evaluationService.deleteEvaluation(authOf(req), id);
  res.status(204).send();
});
