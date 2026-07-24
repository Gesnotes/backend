import { Router } from 'express';
import { z } from 'zod';

import * as gradeBatchService from '../services/gradeBatch.service';
import * as gradeService from '../services/grade.service';
import { authOf } from '../lib/requestContext';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validate } from '../middlewares/validate';

export const gradeRoutes = Router();
export const teacherMeRoutes = Router();

gradeRoutes.use(requireAuth, requireRole('teacher', 'admin'));
teacherMeRoutes.use(requireAuth, requireRole('teacher', 'admin'));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const createBody = z.object({
  evaluationId: z.coerce.number().int().positive(),
  studentId: z.coerce.number().int().positive(),
  value: z.coerce.number().min(0),
  comment: z.string().trim().max(2000).optional(),
});

const updateBody = z
  .object({
    value: z.coerce.number().min(0).optional(),
    comment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

/**
 * Une classe entière tient dans un lot ; la borne à 300 élèves protège
 * seulement contre une requête aberrante. La matière, le type, la période et le
 * barème viennent de l'évaluation.
 */
const batchBody = z.object({
  evaluationId: z.coerce.number().int().positive(),
  entries: z
    .array(
      z.object({
        studentId: z.coerce.number().int().positive(),
        // `null` est signifiant : il efface la note de cet élève.
        value: z.coerce.number().min(0).nullable(),
        comment: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .min(1)
    .max(300),
});

const gridQuery = z.object({
  evaluation_id: z.coerce.number().int().positive(),
});

const historyQuery = z.object({
  class_id: z.coerce.number().int().positive().optional(),
  subject_id: z.coerce.number().int().positive().optional(),
  term_id: z.coerce.number().int().positive().optional(),
});

teacherMeRoutes.get(
  '/classes',
  validate({ query: z.object({ term_id: z.coerce.number().int().positive().optional() }) }),
  async (req, res) => {
    const { term_id } = req.query as unknown as { term_id?: number };
    res.json(await gradeService.listMyClasses(authOf(req), term_id));
  },
);

teacherMeRoutes.get('/grades', validate({ query: gridQuery }), async (req, res) => {
  const { evaluation_id } = req.query as unknown as z.infer<typeof gridQuery>;
  res.json(await gradeService.getEvaluationGrid(authOf(req), evaluation_id));
});

teacherMeRoutes.get('/grades/history', validate({ query: historyQuery }), async (req, res) => {
  const { class_id, subject_id, term_id } = req.query as unknown as z.infer<typeof historyQuery>;
  res.json(
    await gradeService.listMyGradeHistory(authOf(req), {
      classId: class_id,
      subjectId: subject_id,
      termId: term_id,
    }),
  );
});

/**
 * Saisie d'une évaluation entière.
 *
 * `PUT` et non `POST` : l'opération est idempotente et décrit l'état voulu des
 * notes d'une évaluation. Rejouer le même lot — après une coupure réseau, par
 * exemple — ne crée aucun doublon.
 */
teacherMeRoutes.put('/grades', validate({ body: batchBody }), async (req, res) => {
  const data = req.body as z.infer<typeof batchBody>;
  res.json(await gradeBatchService.saveGradeBatch(authOf(req), data));
});

gradeRoutes.post('/', validate({ body: createBody }), async (req, res) => {
  const data = req.body as z.infer<typeof createBody>;
  res.status(201).json(await gradeService.createGrade(authOf(req), data));
});

gradeRoutes.patch(
  '/:id',
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await gradeService.updateGrade(authOf(req), id, data));
  },
);

gradeRoutes.delete('/:id', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  await gradeService.deleteGrade(authOf(req), id);
  res.status(204).send();
});
