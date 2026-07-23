import { Router } from 'express';
import { z } from 'zod';

import * as termService from '../services/term.service';
import { requireAuth } from '../middlewares/requireAuth';
import { ALL_ROLES, requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const termRoutes = Router();

/**
 * Référentiel ouvert aux trois rôles : un parent en a besoin pour choisir la
 * période affichée dans `/children/:id`, au même titre que l'équipe pour le
 * bulletin. La liste ne porte qu'un libellé et deux dates — aucune donnée
 * nominative.
 */
termRoutes.use(requireAuth, requireRole(...ALL_ROLES));

const idParam = z.object({ id: z.coerce.number().int().positive() });

termRoutes.get('/', async (req, res) => {
  res.json(await termService.listTerms(schoolIdOf(req)));
});

termRoutes.get('/:id', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  res.json(await termService.getTerm(schoolIdOf(req), id));
});
