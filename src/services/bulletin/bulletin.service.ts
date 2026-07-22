import prisma from '../../lib/prisma';
import type { AuthPayload } from '../../types/express';
import { assertCanViewClass } from '../class.service';
import { assertIsParentOf } from '../parent.service';
import { computeClassBulletin, computeStudentResult } from '../grading/grading.service';
import {
  type BulletinContext,
  generateClassBulletinPdf,
  generateStudentBulletinPdf,
} from './pdf';
import { notFound } from '../../errors/AppError';

export type BulletinFormat = 'classe' | 'eleves';

export interface BulletinFile {
  buffer: Buffer;
  filename: string;
}

/**
 * Export PDF du bulletin d'une classe.
 *
 * `format=classe` produit le tableau de synthèse (une ligne par élève),
 * `format=eleves` produit une page par élève, le document remis aux familles.
 */
export async function exportClassBulletin(
  auth: AuthPayload,
  classId: number,
  termId: number,
  format: BulletinFormat,
): Promise<BulletinFile> {
  // Même porte d'entrée que la version JSON : un enseignant n'exporte que les
  // classes où il enseigne, un parent n'y accède pas du tout.
  await assertCanViewClass(auth, classId);

  const [bulletin, school] = await Promise.all([
    computeClassBulletin(auth.schoolId, classId, termId),
    prisma.school.findUniqueOrThrow({ where: { id: auth.schoolId } }),
  ]);

  const context: BulletinContext = {
    schoolName: school.name,
    className: bulletin.className,
    level: bulletin.level,
    termLabel: bulletin.termLabel,
    classAverage: bulletin.classAverage,
  };

  const buffer =
    format === 'classe'
      ? await generateClassBulletinPdf(context, bulletin.students)
      : await generateStudentBulletinPdf(context, bulletin.students);

  return {
    buffer,
    filename: slugify(`bulletin-${bulletin.className}-${bulletin.termLabel}-${format}`) + '.pdf',
  };
}

/**
 * Export du bulletin d'un seul élève.
 *
 * Hors spec, mais c'est la pièce qu'un parent demande quand il conteste une
 * moyenne : lui faire télécharger le tableau de toute la classe exposerait les
 * résultats des autres enfants.
 */
export async function exportStudentBulletin(
  auth: AuthPayload,
  studentId: number,
  termId: number,
): Promise<BulletinFile> {
  const { classId } = await assertIsParentOf(auth, studentId);

  // Le bulletin de classe porte déjà tout : le résultat de l'élève, la moyenne
  // de classe (le repère qu'attend un parent, sans exposer aucun résultat
  // individuel), le libellé de la période et le nom de la classe. Le calculer
  // deux fois par deux chemins différents les exposerait à diverger.
  const [bulletin, school] = await Promise.all([
    computeClassBulletin(auth.schoolId, classId, termId),
    prisma.school.findUniqueOrThrow({ where: { id: auth.schoolId } }),
  ]);

  // Un élève archivé est exclu du bulletin de classe : on retombe alors sur le
  // calcul individuel, qui reste valable pour lui.
  const result =
    bulletin.students.find((student) => student.studentId === studentId) ??
    (await computeStudentResult(auth.schoolId, studentId, termId));

  const buffer = await generateStudentBulletinPdf(
    {
      schoolName: school.name,
      className: bulletin.className,
      level: bulletin.level,
      termLabel: bulletin.termLabel,
      classAverage: bulletin.classAverage,
    },
    [result],
  );

  return {
    buffer,
    filename:
      slugify(`bulletin-${result.lastName}-${result.firstName}-${bulletin.termLabel}`) + '.pdf',
  };
}

/** Nom de fichier sûr : pas d'accent, pas d'espace, pas de séparateur. */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    // Plage des diacritiques combinants, échappée : écrite en clair, elle
    // serait invisible dans le source et un simple changement d'encodage la
    // corromprait sans qu'aucun test ne le voie.
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
