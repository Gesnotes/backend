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
  /**
   * Jour local du navigateur, pour la présence du jour. Sans lui, « aujourd'hui »
   * serait calculé sur le fuseau du serveur (UTC) : une école à l'est de Greenwich
   * verrait la présence fraîchement prise datée « demain » jusqu'à minuit UTC, et
   * le tableau de bord annoncerait à tort qu'aucun appel n'a été fait.
   */
  date: z.iso.date().optional(),
});

const recentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const absencesQuery = z.object({
  days: z.coerce.number().int().min(7).max(60).default(14),
  date: z.iso.date().optional(),
});

dashboardRoutes.get('/', validate({ query: dashboardQuery }), async (req, res) => {
  const { term_id, date } = req.query as unknown as z.infer<typeof dashboardQuery>;
  res.json(await dashboardService.getDashboard(schoolIdOf(req), term_id, date));
});

dashboardRoutes.get('/recent-grades', validate({ query: recentQuery }), async (req, res) => {
  const { limit } = req.query as unknown as z.infer<typeof recentQuery>;
  res.json(await dashboardService.getRecentGrades(schoolIdOf(req), limit));
});

dashboardRoutes.get('/absences', validate({ query: absencesQuery }), async (req, res) => {
  const { days, date } = req.query as unknown as z.infer<typeof absencesQuery>;
  res.json(await dashboardService.getAbsenceTrend(schoolIdOf(req), days, date));
});
