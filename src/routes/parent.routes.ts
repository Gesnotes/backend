import { Router } from 'express';
import { z } from 'zod';

import * as parentService from '../services/parent.service';
import { authOf } from '../lib/requestContext';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validate } from '../middlewares/validate';

/** /parents/me — espace du parent connecté. */
export const parentMeRoutes = Router();
/** /children/:id — consultable par le parent, le prof de la classe et l'admin. */
export const childrenRoutes = Router();
/** /grades/:id en lecture — parent ET professeur. */
export const gradeDetailRoutes = Router();

parentMeRoutes.use(requireAuth, requireRole('parent'));
childrenRoutes.use(requireAuth);
gradeDetailRoutes.use(requireAuth);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const termQuery = z.object({ term_id: z.coerce.number().int().positive() });
const optionalTermQuery = z.object({
  term_id: z.coerce.number().int().positive().optional(),
  subject_id: z.coerce.number().int().positive().optional(),
});

parentMeRoutes.get('/children', validate({ query: optionalTermQuery }), async (req, res) => {
  const { term_id } = req.query as unknown as z.infer<typeof optionalTermQuery>;
  res.json(await parentService.listMyChildren(authOf(req), term_id));
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
