import { Router } from 'express';
import { z } from 'zod';

import * as userService from '../services/user.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { authOf, schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

/**
 * /users — vue unifiée des comptes de l'école (admin + enseignant + parent).
 *
 * Complète les écrans existants (Enseignants, fiches élève pour les parents)
 * plutôt que de les remplacer : c'est l'endroit pour voir tous les comptes
 * d'un coup et gérer ceux qui n'ont nulle part ailleurs où l'être (parent,
 * admin). Réservé à l'administration.
 */
export const userRoutes = Router();

userRoutes.use(requireAuth, requireRole('admin'));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const listQuery = z.object({
  role: z.enum(['admin', 'teacher', 'parent']).optional(),
  include_archived: boolFlag,
});

userRoutes.get('/', validate({ query: listQuery }), async (req, res) => {
  const { role, include_archived } = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await userService.listUsers(schoolIdOf(req), { role, includeArchived: include_archived }));
});

userRoutes.delete('/:id', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  res.json(await userService.archiveUserAccount(schoolIdOf(req), id, authOf(req).userId));
});

userRoutes.post('/:id/restore', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  res.json(await userService.restoreUserAccount(schoolIdOf(req), id, authOf(req).userId));
});
