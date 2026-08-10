import { Router } from 'express';
import { z } from 'zod';

import * as enrollmentService from '../services/enrollment.service';
import { authOf } from '../lib/requestContext';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validate } from '../middlewares/validate';

/**
 * /classes/:id/enrollment-decisions — réinscription en lot.
 *
 * Réservée à l'administration : contrairement à la présence ou aux notes,
 * déplacer un élève d'une classe à l'autre est une décision qui engage
 * l'ensemble de la scolarité, pas le geste courant d'un enseignant.
 */
export const enrollmentRoutes = Router();

enrollmentRoutes.use(requireAuth, requireRole('admin'));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const decisionType = z.enum(['promotion', 'redoublement', 'autre'], {
  message: 'La décision doit être "promotion", "redoublement" ou "autre".',
});

/** Une classe entière tient dans un lot, comme la saisie des notes ou de la présence. */
const enrollmentBody = z.object({
  entries: z
    .array(
      z.object({
        studentId: z.coerce.number().int().positive(),
        toClassId: z.coerce.number().int().positive(),
        decision: decisionType,
      }),
    )
    .min(1)
    .max(300),
});

enrollmentRoutes.post(
  '/:id/enrollment-decisions',
  validate({ params: idParam, body: enrollmentBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { entries } = req.body as z.infer<typeof enrollmentBody>;
    res.json(await enrollmentService.reinscrireEleves(authOf(req), id, entries));
  },
);

enrollmentRoutes.get(
  '/:id/enrollment-decisions',
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    res.json(await enrollmentService.listEnrollmentDecisions(authOf(req), id));
  },
);
