import { Router } from 'express';
import { z } from 'zod';

import * as dashboardService from '../services/dashboard.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const dashboardRoutes = Router();

dashboardRoutes.use(requireAuth, requireRole('admin'));

const dashboardQuery = z.object({
  term_id: z.coerce.number().int().positive().optional(),
});

const recentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

dashboardRoutes.get('/', validate({ query: dashboardQuery }), async (req, res) => {
  const { term_id } = req.query as unknown as z.infer<typeof dashboardQuery>;
  res.json(await dashboardService.getDashboard(schoolIdOf(req), term_id));
});

dashboardRoutes.get('/recent-grades', validate({ query: recentQuery }), async (req, res) => {
  const { limit } = req.query as unknown as z.infer<typeof recentQuery>;
  res.json(await dashboardService.getRecentGrades(schoolIdOf(req), limit));
});
