import { Router } from 'express';
import { z } from 'zod';

import * as schoolService from '../services/school.service';
import { requireAuth } from '../middlewares/requireAuth';
import { ALL_ROLES, requireRole } from '../middlewares/requireRole';
import { isValidPhone, PHONE_FORMAT_MESSAGE } from '../lib/normalize';
import { schoolIdOf } from '../lib/requestContext';
import { validate } from '../middlewares/validate';

export const schoolRoutes = Router();

/**
 * Réglages de l'école courante (seuil de passage, coordonnées affichées dans
 * Paramètres).
 *
 * Lecture ouverte aux trois rôles : le seuil sert à interpréter une moyenne
 * partout où elle s'affiche, bulletin parent compris. L'écriture reste à
 * l'administration.
 */
schoolRoutes.use(requireAuth, requireRole(...ALL_ROLES));

const nullableTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));

const updateBody = z
  .object({
    passingGrade: z.coerce.number().min(0).max(20).optional(),
    email: nullableTrimmed(150).refine(
      (value) => value === null || value === undefined || z.email().safeParse(value).success,
      'Adresse email invalide.',
    ),
    phone: nullableTrimmed(30).refine(
      (value) => value === null || value === undefined || isValidPhone(value),
      PHONE_FORMAT_MESSAGE,
    ),
    address: nullableTrimmed(255),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Aucun champ à modifier' });

schoolRoutes.get('/', async (req, res) => {
  res.json(await schoolService.getSchoolSettings(schoolIdOf(req)));
});

schoolRoutes.patch('/', requireRole('admin'), validate({ body: updateBody }), async (req, res) => {
  const patch = req.body as z.infer<typeof updateBody>;
  res.json(await schoolService.updateSchoolSettings(schoolIdOf(req), patch));
});

/**
 * Image d'en-tête/pied de page du bulletin PDF (logo, cachet officiel...).
 *
 * Voyage en JSON (`data:image/png;base64,...`), comme le CSV d'import
 * élèves : pas de dépendance d'upload multipart à embarquer pour des fichiers
 * qui restent, par construction, de quelques centaines de kilo-octets.
 */
const imageBody = z.object({
  image: z.string().min(1, 'Aucune image reçue.').max(3_000_000, 'Cette image est trop lourde.'),
});

const imageSlugToSlot = { 'bulletin-header-image': 'header', 'bulletin-footer-image': 'footer' } as const;

for (const [path, slot] of Object.entries(imageSlugToSlot)) {
  schoolRoutes.get(`/${path}`, async (req, res) => {
    const image = await schoolService.getBulletinImage(schoolIdOf(req), slot);
    if (!image) {
      res.status(404).json({ error: { message: 'Aucune image réglée.' } });
      return;
    }
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(image.data);
  });

  schoolRoutes.put(
    `/${path}`,
    requireRole('admin'),
    validate({ body: imageBody }),
    async (req, res) => {
      const { image } = req.body as z.infer<typeof imageBody>;
      await schoolService.setBulletinImage(schoolIdOf(req), slot, image);
      res.json(await schoolService.getSchoolSettings(schoolIdOf(req)));
    },
  );

  schoolRoutes.delete(`/${path}`, requireRole('admin'), async (req, res) => {
    await schoolService.removeBulletinImage(schoolIdOf(req), slot);
    res.json(await schoolService.getSchoolSettings(schoolIdOf(req)));
  });
}
