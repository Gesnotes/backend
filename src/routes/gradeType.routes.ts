import { Router } from 'express';

import * as gradeTypeService from '../services/gradeType.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';

export const gradeTypeRoutes = Router();

/**
 * Réservé à l'équipe pédagogique : ce référentiel sert à saisir des notes.
 * Le parent reçoit déjà la catégorie de chaque note dans `/children/:id/grades`
 * et n'a pas besoin de la liste complète.
 */
gradeTypeRoutes.use(requireAuth, requireRole('admin', 'teacher'));

gradeTypeRoutes.get('/', async (req, res) => {
  res.json(await gradeTypeService.listGradeTypes(schoolIdOf(req)));
});
