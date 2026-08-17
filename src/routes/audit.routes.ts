import { Router } from 'express';
import { z } from 'zod';

import * as auditService from '../services/audit.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const auditRoutes = Router();

/** Lecture seule, réservée à l'administration : c'est elle qui rend des comptes. */
auditRoutes.use(requireAuth, requireRole('admin'));

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

auditRoutes.get('/', validate({ query: listQuery }), async (req, res) => {
  const { limit } = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await auditService.listAuditLogs(schoolIdOf(req), limit));
});
