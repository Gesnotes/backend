import prisma from '../../lib/prisma';
import type { AuthPayload } from '../../types/express';
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
  schoolId: number,
  classId: number,
  termId: number,
  format: BulletinFormat,
): Promise<BulletinFile> {
  const bulletin = await computeClassBulletin(schoolId, classId, termId);
  const school = await prisma.school.findUniqueOrThrow({ where: { id: schoolId } });

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
  await assertIsParentOf(auth, studentId);

  const [student, term, school] = await Promise.all([
    prisma.student.findFirstOrThrow({
      where: { id: studentId, schoolId: auth.schoolId },
      include: { class: { select: { name: true, level: true } } },
    }),
    prisma.term.findFirst({ where: { id: termId, schoolId: auth.schoolId } }),
    prisma.school.findUniqueOrThrow({ where: { id: auth.schoolId } }),
  ]);

  if (!term) throw notFound('Période introuvable');

  const result = await computeStudentResult(auth.schoolId, studentId, termId);

  // La moyenne de classe reste affichée : c'est le repère qu'attend un parent,
  // et elle n'expose aucun résultat individuel d'un autre élève.
  const classBulletin = await computeClassBulletin(auth.schoolId, student.classId, termId);

  const buffer = await generateStudentBulletinPdf(
    {
      schoolName: school.name,
      className: student.class.name,
      level: student.class.level,
      termLabel: term.label,
      classAverage: classBulletin.classAverage,
    },
    [result],
  );

  return {
    buffer,
    filename:
      slugify(`bulletin-${student.lastName}-${student.firstName}-${term.label}`) + '.pdf',
  };
}

/** Nom de fichier sûr : pas d'accent, pas d'espace, pas de séparateur. */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
