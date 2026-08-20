import type { Prisma } from '../generated/prisma/client';
import { labelKey } from '../lib/normalize';

interface LevelTemplate {
  mode: 'notes' | 'presence';
  classLevels: string[];
  subjects: string[];
}

/**
 * Gabarit de démarrage par cycle scolaire — les niveaux cochés sur le
 * formulaire d'inscription (`SignupPage.tsx`, `NIVEAUX`), rendus réels à
 * l'acceptation de la demande plutôt que purement déclaratifs.
 *
 * Coefficient toujours à 1 : ce n'est qu'un point de départ que l'école
 * réajuste ensuite (écran Matières, coefficients par classe) — l'essentiel
 * est de ne pas partir d'un établissement complètement vide.
 *
 * Les libellés de niveau suivent la convention déjà en usage dans
 * `prisma/seed-demo.ts` et les tests (pas d'accent : « 1ere », « Tle »).
 */
const CATALOG: Record<string, LevelTemplate> = {
  [labelKey('Garderie')]: {
    mode: 'presence',
    classLevels: ['Garderie'],
    subjects: [],
  },
  [labelKey('Maternelle')]: {
    mode: 'presence',
    classLevels: ['Petite Section', 'Moyenne Section', 'Grande Section'],
    subjects: [],
  },
  [labelKey('Primaire')]: {
    mode: 'notes',
    classLevels: ['CI', 'CP', 'CE1', 'CE2', 'CM1', 'CM2'],
    subjects: ['Français', 'Mathématiques', 'Éveil', 'Anglais', 'EPS'],
  },
  [labelKey('Collège')]: {
    mode: 'notes',
    classLevels: ['6e', '5e', '4e', '3e'],
    subjects: ['Français', 'Mathématiques', 'Anglais', 'SVT', 'Physique-Chimie', 'Histoire-Géographie', 'EPS'],
  },
  [labelKey('Secondaire')]: {
    mode: 'notes',
    classLevels: ['2nde', '1ere', 'Tle'],
    subjects: [
      'Français', 'Mathématiques', 'Anglais', 'Philosophie', 'SVT', 'Physique-Chimie', 'Histoire-Géographie', 'EPS',
    ],
  },
};

/**
 * Provisionne une école toute neuve à partir des niveaux cochés à
 * l'inscription : les matières standard du cycle (coefficient 1) et une
 * classe par niveau (que l'admin renomme ou duplique ensuite en sections
 * réelles — « 6e » devient « 6e A », « 6e B »...).
 *
 * Réservé à une école qui vient d'être créée dans la même transaction
 * (`staff.service.ts::acceptSignupRequest`) : aucune vérification de doublon
 * n'est faite, il ne peut structurellement pas y en avoir. Un niveau coché
 * qui ne correspond à aucune entrée du catalogue (texte libre non reconnu)
 * est simplement ignoré — rien à en déduire.
 */
export async function provisionFromLevels(
  tx: Prisma.TransactionClient,
  schoolId: number,
  levels: string[],
): Promise<void> {
  const templates = levels
    .map((level) => CATALOG[labelKey(level)])
    .filter((template): template is LevelTemplate => template !== undefined);

  if (templates.length === 0) return;

  const subjectNames = [...new Set(templates.flatMap((t) => t.subjects))];
  const subjectIdByName = new Map<string, number>();
  for (const name of subjectNames) {
    const subject = await tx.subject.create({ data: { schoolId, name, coefficient: 1 } });
    subjectIdByName.set(name, subject.id);
  }

  // Un même niveau (rare) pourrait apparaître dans deux cycles cochés à la
  // fois : le premier gabarit rencontré fixe son mode et ses matières,
  // aucune entrée du catalogue actuel ne se chevauche de toute façon.
  const levelOrder: string[] = [];
  const modeByLevel = new Map<string, LevelTemplate['mode']>();
  const subjectsByLevel = new Map<string, string[]>();
  for (const template of templates) {
    for (const classLevel of template.classLevels) {
      if (modeByLevel.has(classLevel)) continue;
      levelOrder.push(classLevel);
      modeByLevel.set(classLevel, template.mode);
      subjectsByLevel.set(classLevel, template.subjects);
    }
  }

  for (const classLevel of levelOrder) {
    const mode = modeByLevel.get(classLevel)!;
    const klass = await tx.class.create({
      data: { schoolId, name: classLevel, level: classLevel, mode },
    });

    if (mode !== 'notes') continue;

    for (const subjectName of subjectsByLevel.get(classLevel) ?? []) {
      const subjectId = subjectIdByName.get(subjectName);
      if (subjectId === undefined) continue;
      await tx.subjectCoefficient.create({
        data: { classId: klass.id, subjectId, coefficient: 1 },
      });
    }
  }
}
