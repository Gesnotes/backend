import { Router } from 'express';
import { z } from 'zod';

import * as termService from '../services/term.service';
import { requireAuth } from '../middlewares/requireAuth';
import { ALL_ROLES, requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const termRoutes = Router();

/**
 * Lecture ouverte aux trois rôles : un parent en a besoin pour choisir la
 * période affichée dans `/children/:id`, au même titre que l'équipe pour le
 * bulletin. La liste ne porte qu'un libellé et deux dates — aucune donnée
 * nominative. L'écriture reste à l'administration.
 */
termRoutes.use(requireAuth, requireRole(...ALL_ROLES));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const createBody = z.object({
  label: z.string().trim().min(1).max(50),
  startDate: z.iso.date().nullable().optional(),
  endDate: z.iso.date().nullable().optional(),
});

const updateBody = createBody
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

termRoutes.get('/', async (req, res) => {
  res.json(await termService.listTerms(schoolIdOf(req)));
});

termRoutes.get('/:id', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  res.json(await termService.getTerm(schoolIdOf(req), id));
});

termRoutes.post('/', requireRole('admin'), validate({ body: createBody }), async (req, res) => {
  const data = req.body as z.infer<typeof createBody>;
  res.status(201).json(await termService.createTerm(schoolIdOf(req), data));
});

termRoutes.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await termService.updateTerm(schoolIdOf(req), id, data));
  },
);

termRoutes.delete(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    await termService.deleteTerm(schoolIdOf(req), id);
    res.status(204).send();
  },
);
