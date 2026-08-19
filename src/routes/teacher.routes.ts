import { Router } from 'express';
import { z } from 'zod';

import * as teacherService from '../services/teacher.service';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { authOf, schoolIdOf } from '../lib/requestContext';
import { isValidPhone, PHONE_FORMAT_MESSAGE } from '../lib/normalize';
import { validate } from '../middlewares/validate';

export const teacherRoutes = Router();

// Gestion des comptes enseignants : réservée à l'administration.
teacherRoutes.use(requireAuth, requireRole('admin'));

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = z.object({
  include_archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

const assignmentSchema = z.object({
  classId: z.coerce.number().int().positive(),
  subjectId: z.coerce.number().int().positive(),
});

/**
 * Le téléphone sert d'identifiant de connexion : un numéro mal saisi ne se voit
 * pas à la création, il se découvre le jour où l'enseignant n'arrive pas à se
 * connecter. La chaîne vide vaut « pas de numéro » et reste acceptée.
 */
const phoneField = z
  .string()
  .trim()
  .max(30)
  .refine((value) => value === '' || isValidPhone(value), PHONE_FORMAT_MESSAGE);

const createBody = z.object({
  email: z.email(),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  phone: phoneField.optional(),
  assignments: z.array(assignmentSchema).max(50).optional(),
});

const updateBody = z
  .object({
    email: z.email().optional(),
    firstName: z.string().trim().max(100).nullable().optional(),
    lastName: z.string().trim().max(100).nullable().optional(),
    phone: phoneField.nullable().optional(),
    assignments: z.array(assignmentSchema).max(50).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

const deleteQuery = z.object({
  permanent: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  confirm_label: z.string().optional(),
});

teacherRoutes.get('/', validate({ query: listQuery }), async (req, res) => {
  const { include_archived } = req.query as unknown as z.infer<typeof listQuery>;
  res.json(await teacherService.listTeachers(schoolIdOf(req), include_archived));
});

teacherRoutes.post('/', validate({ body: createBody }), async (req, res) => {
  const data = req.body as z.infer<typeof createBody>;
  res.status(201).json(await teacherService.createTeacher(schoolIdOf(req), data));
});

/** Fiche complète : identité, affectations, dernières notes et présences saisies par ce compte. */
teacherRoutes.get('/:id/detail', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  res.json(await teacherService.getTeacherDetail(schoolIdOf(req), id));
});

teacherRoutes.patch(
  '/:id',
  validate({ params: idParam, body: updateBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof updateBody>;
    res.json(await teacherService.updateTeacher(schoolIdOf(req), id, data));
  },
);

/**
 * Désactivation par défaut (les notes saisies sont conservées).
 * `?permanent=true&confirm_label=` supprime réellement un compte déjà
 * archivé, en retapant son nom exact, et échoue si des notes existent.
 */
teacherRoutes.delete(
  '/:id',
  validate({ params: idParam, query: deleteQuery }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { permanent, confirm_label } = req.query as unknown as z.infer<typeof deleteQuery>;

    if (permanent) {
      await teacherService.deleteTeacherPermanently(schoolIdOf(req), id, confirm_label ?? '', authOf(req).userId);
    } else {
      await teacherService.archiveTeacher(schoolIdOf(req), id, authOf(req).userId);
    }
    res.status(204).send();
  },
);

teacherRoutes.post('/:id/restore', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  res.json(await teacherService.restoreTeacher(schoolIdOf(req), id, authOf(req).userId));
});

/** Renvoie une nouvelle invitation (email perdu, lien expiré). */
teacherRoutes.post('/:id/invitation', validate({ params: idParam }), async (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParam>;
  const teacher = await teacherService.getTeacher(schoolIdOf(req), id);
  await teacherService.sendInvitation(teacher.id, teacher.email, 'teacher');
  res.json({ message: 'Invitation envoyée.' });
});
