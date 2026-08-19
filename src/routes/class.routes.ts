import { Router } from 'express';
import { z } from 'zod';

import * as attendanceService from '../services/attendance.service';
import * as bulletinService from '../services/bulletin/bulletin.service';
import * as classService from '../services/class.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { authOf, schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const classRoutes = Router();

/**
 * Aucune route de ce routeur n'est destinée aux parents : toutes exposent des
 * données agrégées sur l'ensemble d'une classe. Un parent consulte son enfant
 * via /children/:id. Le contrôle par classe (l'enseignant n'accède qu'aux
 * siennes) est fait dans le service, cf. `assertCanViewClass`.
 */
classRoutes.use(requireAuth, requireRole('admin', 'teacher'));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const listQuery = z.object({
  term_id: z.coerce.number().int().positive().optional(),
  school_year_id: z.coerce.number().int().positive().optional(),
  include_archived: boolFlag,
});

const detailQuery = z.object({ term_id: z.coerce.number().int().positive() });

const modeField = z.enum(['notes', 'presence'], {
  message: 'Le mode doit être "notes" ou "presence".',
});

const createBody = z.object({
  name: z.string({ message: 'Le nom de la classe est obligatoire.' }).trim().min(1, 'Le nom de la classe est obligatoire.').max(50, 'Le nom ne doit pas dépasser 50 caractères.'),
  level: z.string({ message: 'Le niveau est obligatoire.' }).trim().min(1, 'Le niveau est obligatoire.').max(20, 'Le niveau ne doit pas dépasser 20 caractères.'),
  mode: modeField.optional(),
  homeroomTeacherId: z.coerce.number().int().positive().optional(),
  schoolYearId: z.coerce.number().int().positive().optional(),
  copyCoefficientsFromClassId: z.coerce.number().int().positive().optional(),
});

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(50).optional(),
    level: z.string().trim().min(1).max(20).optional(),
    mode: modeField.optional(),
    homeroomTeacherId: z.coerce.number().int().positive().nullable().optional(),
    schoolYearId: z.coerce.number().int().positive().nullable().optional(),
    promotesToId: z.coerce.number().int().positive().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

/** `name`/`level` par défaut : ceux de la classe dupliquée. */
const duplicateBody = z.object({
  schoolYearId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(50).optional(),
  level: z.string().trim().min(1).max(20).optional(),
});

const deleteQuery = z.object({ permanent: boolFlag, confirm_label: z.string().optional() });

classRoutes.get('/', validate({ query: listQuery }), async (req, res) => {
  const { term_id, school_year_id, include_archived } = req.query as unknown as z.infer<
    typeof listQuery
  >;
  res.json(
    await classService.listClasses(schoolIdOf(req), term_id, include_archived, school_year_id),
  );
});

/** Détail : élèves classés par moyenne + statistiques de la classe. */
classRoutes.get(
  '/:id',
  validate({ params: idParam, query: detailQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { term_id } = req.query as unknown as z.infer<typeof detailQuery>;
    res.json(await classService.getClassDetail(authOf(req), id, term_id));
  },
);

/** Tableau moyennes par élève × matière, base du bulletin PDF (lot 12). */
classRoutes.get(
  '/:id/bulletin',
  validate({ params: idParam, query: detailQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { term_id } = req.query as unknown as z.infer<typeof detailQuery>;
    res.json(await classService.getClassDetail(authOf(req), id, term_id));
  },
);

/** Récap de présence de la classe sur une période : compteurs par élève. */
classRoutes.get(
  '/:id/attendance-summary',
  validate({ params: idParam, query: detailQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { term_id } = req.query as unknown as z.infer<typeof detailQuery>;
    res.json(await attendanceService.getClassAttendanceSummary(authOf(req), id, term_id));
  },
);

/**
 * Export PDF. `format=eleves` (défaut) : une page par élève, le document
 * remis aux familles. `format=classe` : le tableau de synthèse.
 */
classRoutes.get(
  '/:id/bulletin/export',
  validate({
    params: idParam,
    query: detailQuery.extend({
      format: z.enum(['eleves', 'classe']).default('eleves'),
    }),
  }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { term_id, format } = req.query as unknown as {
      term_id: number;
      format: 'eleves' | 'classe';
    };

    const file = await bulletinService.exportClassBulletin(authOf(req), id, term_id, format);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Length', String(file.buffer.length));
    res.send(file.buffer);
  },
);

/**
 * Export tableur. Route distincte de l'export PDF : ce n'est pas une variante
 * de mise en page mais un autre usage — le PDF se remet aux familles, le CSV se
 * retravaille.
 */
classRoutes.get(
  '/:id/bulletin/csv',
  validate({ params: idParam, query: detailQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { term_id } = req.query as unknown as z.infer<typeof detailQuery>;

    const file = await bulletinService.exportClassBulletinCsv(authOf(req), id, term_id);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  },
);

classRoutes.post('/', requireRole('admin'), validate({ body: createBody }), async (req, res) => {
  const data = req.body as z.infer<typeof createBody>;
  res.status(201).json(await classService.createClass(schoolIdOf(req), data));
});

classRoutes.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await classService.updateClass(schoolIdOf(req), id, data));
  },
);

classRoutes.delete(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, query: deleteQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { permanent, confirm_label } = req.query as unknown as z.infer<typeof deleteQuery>;
    await classService.deleteClass(schoolIdOf(req), id, permanent, confirm_label ?? '');
    res.status(204).send();
  },
);

classRoutes.post(
  '/:id/restore',
  requireRole('admin'),
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    res.json(await classService.restoreClass(schoolIdOf(req), id));
  },
);

/**
 * Prépare la rentrée suivante : nouvelle classe dans l'année scolaire visée,
 * qui reprend le mode, le référent et les coefficients de celle-ci.
 */
classRoutes.post(
  '/:id/duplicate',
  requireRole('admin'),
  validate({ params: idParam, body: duplicateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof duplicateBody>;
    res.status(201).json(await classService.duplicateClassForNextYear(schoolIdOf(req), id, data));
  },
);
