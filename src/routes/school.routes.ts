import { Router } from 'express';
import { z } from 'zod';

import * as schoolService from '../services/school.service';
import { requireAuth } from '../middlewares/requireAuth';
import { ALL_ROLES, requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const schoolRoutes = Router();

/**
 * Réglages de l'école courante (pour l'instant : le seuil de passage).
 *
 * Lecture ouverte aux trois rôles : le seuil sert à interpréter une moyenne
 * partout où elle s'affiche, bulletin parent compris. L'écriture reste à
 * l'administration.
 */
schoolRoutes.use(requireAuth, requireRole(...ALL_ROLES));

const updateBody = z.object({
  passingGrade: z.coerce.number().min(0).max(20),
});

schoolRoutes.get('/', async (req, res) => {
  res.json(await schoolService.getSchoolSettings(schoolIdOf(req)));
});

schoolRoutes.patch('/', requireRole('admin'), validate({ body: updateBody }), async (req, res) => {
  const { passingGrade } = req.body as z.infer<typeof updateBody>;
  res.json(await schoolService.updatePassingGrade(schoolIdOf(req), passingGrade));
});
