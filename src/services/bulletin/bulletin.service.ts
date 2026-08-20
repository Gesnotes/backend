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
import { conflict, notFound } from '../../errors/AppError';
import { formatAverage, toCsv, type CsvCell } from '../../lib/csv';

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

  assertBulletinReady(bulletin);

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

  // Le bulletin n'est remis à une famille que lorsque toute la classe est
  // couverte, pas seulement l'enfant concerné : même règle que l'export de
  // classe, pour ne jamais distribuer un document à colonnes manquantes.
  assertBulletinReady(bulletin);

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

/**
 * Export tableur du bulletin d'une classe.
 *
 * Le PDF est fait pour être remis aux familles ; celui-ci est fait pour être
 * retravaillé — trier par moyenne, isoler une matière, recopier dans le tableau
 * de l'inspection. C'est la demande concrète des écoles, et le PDF n'y répond
 * pas.
 *
 * Une colonne par matière notée, dans le même ordre que le tableau à l'écran,
 * puis moyenne et rang. Les élèves sont classés par moyenne décroissante, les
 * non évalués en fin — un élève sans note n'est pas dernier de la classe.
 */
export async function exportClassBulletinCsv(
  auth: AuthPayload,
  classId: number,
  termId: number,
): Promise<{ content: string; filename: string }> {
  await assertCanViewClass(auth, classId);

  const bulletin = await computeClassBulletin(auth.schoolId, classId, termId);
  assertBulletinReady(bulletin);

  // Le calcul ne retient que les matières notées, et chaque élève porte la même
  // liste : la lire sur le premier suffit, et éviter l'union empêche les
  // colonnes fantômes.
  const subjects = bulletin.students[0]?.subjects ?? [];

  const ranked = [...bulletin.students].sort((a, b) => {
    if (a.average === null && b.average === null) {
      return a.lastName.localeCompare(b.lastName, 'fr');
    }
    if (a.average === null) return 1;
    if (b.average === null) return -1;
    return b.average - a.average;
  });

  const header: CsvCell[] = [
    'Nom',
    'Prénom',
    ...subjects.map((subject) => `${subject.subjectName} (coef. ${subject.coefficient})`),
    'Moyenne',
    'Rang',
  ];

  let rank = 0;
  const rows: CsvCell[][] = ranked.map((student) => {
    if (student.average !== null) rank += 1;
    return [
      student.lastName,
      student.firstName,
      ...subjects.map((subject) =>
        formatAverage(
          student.subjects.find((s) => s.subjectId === subject.subjectId)?.average,
        ),
      ),
      formatAverage(student.average),
      // Chaîne et non nombre : le formateur de cellules met deux décimales,
      // ce qui a du sens pour une moyenne et donnerait « 1,00 » pour un rang.
      student.average === null ? '—' : String(rank),
    ];
  });

  // Une ligne de synthèse plutôt qu'une cellule isolée : elle survit à un tri.
  const footer: CsvCell[] = [
    'Moyenne de la classe',
    '',
    ...subjects.map(() => ''),
    formatAverage(bulletin.classAverage),
    '',
  ];

  return {
    content: toCsv([header, ...rows, footer]),
    filename: slugify(`bulletin-${bulletin.className}-${bulletin.termLabel}`) + '.csv',
  };
}

/**
 * Refuse de produire un bulletin tant qu'il n'est pas complet.
 *
 * Un bulletin n'est remis aux familles qu'à la fin d'une période, quand
 * chaque matière attendue de la classe a été notée (`bulletinReady`, calculé
 * par `computeClassBulletin`) — jamais un document à colonnes manquantes. Le
 * refus arrive après le calcul, mais avant la génération — la partie chère.
 */
function assertBulletinReady(bulletin: {
  students: unknown[];
  termLabel: string;
  bulletinReady: boolean;
  missingSubjects: string[];
}) {
  if (bulletin.students.length === 0) {
    throw conflict(
      "Aucun élève dans cette classe : il n'y a pas de bulletin à produire.",
    );
  }

  if (bulletin.bulletinReady) return;

  if (bulletin.missingSubjects.length === 0) {
    throw conflict(
      `Aucune note saisie sur « ${bulletin.termLabel} » : le bulletin serait vide. Attendez les saisies des enseignants.`,
    );
  }

  throw conflict(
    `Le bulletin de « ${bulletin.termLabel} » n'est pas encore complet : il manque les notes de ${bulletin.missingSubjects.join(', ')}. Il sera disponible une fois toutes les matières notées.`,
  );
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
