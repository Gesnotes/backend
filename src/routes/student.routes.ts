import { Router } from 'express';
import { z } from 'zod';

import * as studentService from '../services/student.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { authOf, schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const studentRoutes = Router();
export const parentSearchRoutes = Router();

studentRoutes.use(requireAuth);

const idParam = z.object({ id: z.coerce.number().int().positive() });

const parentParams = z.object({
  id: z.coerce.number().int().positive(),
  parentId: z.coerce.number().int().positive(),
});

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const listQuery = z.object({
  class_id: z.coerce.number().int().positive().optional(),
  include_archived: boolFlag,
  page: z.coerce.number().int().positive().default(1),
});

const createBody = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  classId: z.coerce.number().int().positive(),
  birthDate: z.iso.date().optional(),
});

const updateBody = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    classId: z.coerce.number().int().positive().optional(),
    birthDate: z.iso.date().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

/**
 * La suppression définitive exige le nom exact de l'élève : elle efface sa
 * scolarité complète, sans retour possible.
 */
const deleteQuery = z.object({
  permanent: boolFlag,
  confirm_name: z.string().optional(),
});

/** Association : soit un compte existant, soit un nouveau par invitation. */
const attachParentBody = z.union([
  z.object({ parentUserId: z.coerce.number().int().positive() }),
  z.object({
    email: z.email(),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(30).optional(),
  }),
]);

/**
 * Lecture réservée à l'équipe. Le service borne en plus l'enseignant à ses
 * classes et lui masque les coordonnées des familles. Un parent consulte ses
 * enfants via /parents/me/children.
 */
studentRoutes.get(
  '/',
  requireRole('admin', 'teacher'),
  validate({ query: listQuery }),
  async (req, res) => {
    const { class_id, include_archived, page } = req.query as unknown as z.infer<typeof listQuery>;
    res.json(
      await studentService.listStudents(authOf(req), {
        classId: class_id,
        includeArchived: include_archived,
        page,
      }),
    );
  },
);

studentRoutes.get(
  '/:id',
  requireRole('admin', 'teacher'),
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    res.json(await studentService.getStudent(authOf(req), id));
  },
);

studentRoutes.post('/', requireRole('admin'), validate({ body: createBody }), async (req, res) => {
  const data = req.body as z.infer<typeof createBody>;
  res.status(201).json(await studentService.createStudent(schoolIdOf(req), data));
});

studentRoutes.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await studentService.updateStudent(schoolIdOf(req), id, data));
  },
);

studentRoutes.delete(
  '/:id',
  requireRole('admin'),
  validate({ params: idParam, query: deleteQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { permanent, confirm_name } = req.query as unknown as z.infer<typeof deleteQuery>;

    if (permanent) {
      await studentService.deleteStudentPermanently(schoolIdOf(req), id, confirm_name ?? '');
    } else {
      await studentService.archiveStudent(schoolIdOf(req), id);
    }
    res.status(204).send();
  },
);

studentRoutes.post(
  '/:id/restore',
  requireRole('admin'),
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    res.json(await studentService.restoreStudent(schoolIdOf(req), id));
  },
);

studentRoutes.post(
  '/:id/parents',
  requireRole('admin'),
  validate({ params: idParam, body: attachParentBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const body = req.body as z.infer<typeof attachParentBody>;
    res.status(201).json(await studentService.attachParent(schoolIdOf(req), id, body));
  },
);

studentRoutes.delete(
  '/:id/parents/:parentId',
  requireRole('admin'),
  validate({ params: parentParams }),
  async (req, res) => {
    const { id, parentId } = req.params as unknown as z.infer<typeof parentParams>;
    res.json(await studentService.detachParent(schoolIdOf(req), id, parentId));
  },
);

/** Renvoie une invitation à un parent déjà associé (email perdu, lien expiré). */
studentRoutes.post(
  '/:id/parents/:parentId/invitation',
  requireRole('admin'),
  validate({ params: parentParams }),
  async (req, res) => {
    const { id, parentId } = req.params as unknown as z.infer<typeof parentParams>;
    await studentService.resendParentInvitation(schoolIdOf(req), id, parentId);
    res.json({ message: 'Invitation envoyée.' });
  },
);

/** GET /parents/search?q= — recherche d'un compte parent à associer. */
parentSearchRoutes.get(
  '/search',
  requireAuth,
  requireRole('admin'),
  validate({ query: z.object({ q: z.string().min(1) }) }),
  async (req, res) => {
    const { q } = req.query as unknown as { q: string };
    res.json(await studentService.searchParents(schoolIdOf(req), q));
  },
);
