import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, resetDatabase, seedGrade } from './helpers';
import {
  checkDuplicateWarning,
  computeClassBulletin,
  computeStudentResult,
} from '../src/services/grading/grading.service';

let school: { id: number };
let klass: { id: number };
let term: { id: number };
let maths: { id: number };
let francais: { id: number };
let types: Record<string, number>;
let ana: { id: number };
let ben: { id: number };

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');
  klass = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });

  maths = await prisma.subject.create({
    data: { schoolId: school.id, name: 'Maths', coefficient: 4 },
  });
  francais = await prisma.subject.create({
    data: { schoolId: school.id, name: 'Français', coefficient: 1 },
  });

  const created = await Promise.all(
    [
      { code: 'interrogation', label: 'Interrogation', weight: 1, position: 1 },
      { code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
      { code: 'composition', label: 'Composition', weight: 3, position: 3 },
    ].map((t) => prisma.gradeType.create({ data: { schoolId: school.id, ...t } })),
  );
  types = Object.fromEntries(created.map((t) => [t.code, t.id]));

  ana = await prisma.student.create({
    data: { schoolId: school.id, classId: klass.id, firstName: 'Ana', lastName: 'Alpha' },
  });
  ben = await prisma.student.create({
    data: { schoolId: school.id, classId: klass.id, firstName: 'Ben', lastName: 'Beta' },
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const addGrade = (
  studentId: number,
  subjectId: number,
  code: string,
  value: number,
  maxValue = 20,
) =>
  seedGrade({
    schoolId: school.id,
    studentId,
    subjectId,
    gradeTypeId: types[code]!,
    termId: term.id,
    value,
    maxValue,
  });

describe('computeStudentResult', () => {
  it("reproduit l'exemple du plan, recalculé à la main", async () => {
    // Interros 12, 15, 9 → 12 ; devoir 14 ; compo 16
    // (12 + 2×14 + 3×16) / 6 = 14.67
    await addGrade(ana.id, maths.id, 'interrogation', 12);
    await addGrade(ana.id, maths.id, 'interrogation', 15);
    await addGrade(ana.id, maths.id, 'interrogation', 9);
    await addGrade(ana.id, maths.id, 'devoir', 14);
    await addGrade(ana.id, maths.id, 'composition', 16);

    const result = await computeStudentResult(school.id, ana.id, term.id);
    expect(result.subjects[0]!.average).toBe(14.67);
    expect(result.average).toBe(14.67);
  });

  it('pondère les matières par leur coefficient', async () => {
    // Devoir aligné sur la composition : ne change pas la moyenne de matière,
    // sert seulement à passer le seuil de publication (devoir + composition).
    await addGrade(ana.id, maths.id, 'devoir', 15);
    await addGrade(ana.id, maths.id, 'composition', 15); // coef 4
    await addGrade(ana.id, francais.id, 'devoir', 10);
    await addGrade(ana.id, francais.id, 'composition', 10); // coef 1

    // (15×4 + 10×1) / 5 = 14
    const result = await computeStudentResult(school.id, ana.id, term.id);
    expect(result.average).toBe(14);
  });

  it('utilise la surcharge de coefficient de la classe', async () => {
    await prisma.subjectCoefficient.create({
      data: { subjectId: maths.id, classId: klass.id, coefficient: 1 },
    });
    await addGrade(ana.id, maths.id, 'devoir', 15);
    await addGrade(ana.id, maths.id, 'composition', 15);
    await addGrade(ana.id, francais.id, 'devoir', 10);
    await addGrade(ana.id, francais.id, 'composition', 10);

    // Maths retombe à coef 1 : (15+10)/2 = 12.5 au lieu de 14.
    const result = await computeStudentResult(school.id, ana.id, term.id);
    expect(result.average).toBe(12.5);
  });

  it('renvoie null pour un élève sans aucune note', async () => {
    const result = await computeStudentResult(school.id, ana.id, term.id);
    expect(result.average).toBeNull();
    expect(result.subjects).toHaveLength(0);
  });

  it('ignore les notes des autres périodes', async () => {
    const other = await prisma.term.create({
      data: { schoolId: school.id, label: 'Trimestre 2' },
    });
    await addGrade(ana.id, maths.id, 'devoir', 15);
    await addGrade(ana.id, maths.id, 'composition', 15);
    await seedGrade({
      schoolId: school.id,
      studentId: ana.id,
      subjectId: maths.id,
      gradeTypeId: types.composition!,
      termId: other.id,
      value: 5,
    });

    const result = await computeStudentResult(school.id, ana.id, term.id);
    expect(result.average).toBe(15);
  });

  it('expose le détail par catégorie, ordonné', async () => {
    await addGrade(ana.id, maths.id, 'composition', 16);
    await addGrade(ana.id, maths.id, 'interrogation', 12);

    const result = await computeStudentResult(school.id, ana.id, term.id);
    const categories = result.subjects[0]!.categories;

    expect(categories.map((c) => c.label)).toEqual(['Interrogation', 'Composition']);
    expect(categories[0]!.weight).toBe(1);
    expect(categories[1]!.average).toBe(16);
  });

  it("refuse l'élève d'une autre école", async () => {
    const other = await createSchool('ecole-b');
    const otherClass = await prisma.class.create({
      data: { schoolId: other.id, name: '6e B', level: '6e' },
    });
    const foreign = await prisma.student.create({
      data: { schoolId: other.id, classId: otherClass.id, firstName: 'X', lastName: 'Y' },
    });

    await expect(computeStudentResult(school.id, foreign.id, term.id)).rejects.toThrow();
  });
});

describe('computeClassBulletin', () => {
  it('classe les élèves et calcule la moyenne de classe', async () => {
    await addGrade(ana.id, maths.id, 'devoir', 16);
    await addGrade(ana.id, maths.id, 'composition', 16);
    await addGrade(ben.id, maths.id, 'devoir', 12);
    await addGrade(ben.id, maths.id, 'composition', 12);

    const bulletin = await computeClassBulletin(school.id, klass.id, term.id);

    expect(bulletin.students).toHaveLength(2);
    expect(bulletin.students.find((s) => s.studentId === ana.id)!.average).toBe(16);
    expect(bulletin.students.find((s) => s.studentId === ben.id)!.average).toBe(12);
    expect(bulletin.classAverage).toBe(14);
  });

  it('exclut les élèves archivés du bulletin et de la moyenne', async () => {
    await addGrade(ana.id, maths.id, 'devoir', 16);
    await addGrade(ana.id, maths.id, 'composition', 16);
    await addGrade(ben.id, maths.id, 'composition', 4);
    await prisma.student.update({ where: { id: ben.id }, data: { archivedAt: new Date() } });

    const bulletin = await computeClassBulletin(school.id, klass.id, term.id);
    expect(bulletin.students).toHaveLength(1);
    expect(bulletin.classAverage).toBe(16);
  });

  it("n'écrase pas la moyenne de classe avec les élèves sans note", async () => {
    await addGrade(ana.id, maths.id, 'devoir', 16);
    await addGrade(ana.id, maths.id, 'composition', 16);
    // Ben n'a aucune note : il apparaît avec null, sans tirer la moyenne vers 0.

    const bulletin = await computeClassBulletin(school.id, klass.id, term.id);
    expect(bulletin.students.find((s) => s.studentId === ben.id)!.average).toBeNull();
    expect(bulletin.classAverage).toBe(16);
  });

  it('donne exactement les mêmes moyennes que le calcul par élève', async () => {
    await addGrade(ana.id, maths.id, 'interrogation', 12);
    await addGrade(ana.id, maths.id, 'devoir', 14);
    await addGrade(ana.id, francais.id, 'composition', 9);
    await addGrade(ben.id, maths.id, 'composition', 11);

    const bulletin = await computeClassBulletin(school.id, klass.id, term.id);

    for (const student of [ana, ben]) {
      const solo = await computeStudentResult(school.id, student.id, term.id);
      const inBulletin = bulletin.students.find((s) => s.studentId === student.id)!;
      expect(inBulletin.average).toBe(solo.average);
    }
  });

  it('reste rapide et exact sur une classe entière', async () => {
    // 22 élèves × 2 matières × 3 notes = 132 notes. Le chemin naïf (une
    // requête par élève et par matière) ferait des centaines d'allers-retours
    // SQL ; le chemin batch en fait trois, quel que soit l'effectif.
    for (let i = 0; i < 20; i += 1) {
      const student = await prisma.student.create({
        data: {
          schoolId: school.id,
          classId: klass.id,
          firstName: `E${i}`,
          lastName: `Nom${i}`,
        },
      });
      for (const subject of [maths, francais]) {
        await addGrade(student.id, subject.id, 'interrogation', 10 + (i % 10));
        await addGrade(student.id, subject.id, 'devoir', 12);
        await addGrade(student.id, subject.id, 'composition', 14);
      }
    }

    const before = Date.now();
    const bulletin = await computeClassBulletin(school.id, klass.id, term.id);
    const elapsed = Date.now() - before;

    expect(bulletin.students).toHaveLength(22);
    // Un bulletin de classe doit rester interactif.
    expect(elapsed).toBeLessThan(1500);

    // Exactitude préservée à l'échelle : (10 + 2×12 + 3×14) / 6 = 12.67
    const premier = bulletin.students.find((s) => s.firstName === 'E0')!;
    expect(premier.average).toBe(12.67);
  });

  it("n'attribue pas à la nouvelle classe une note gagnée dans l'ancienne (élève déplacé)", async () => {
    const otherClass = await prisma.class.create({
      data: { schoolId: school.id, name: '5e A', level: '5e' },
    });

    // La note s'ancre à klass via son évaluation (seedGrade la crée sur la
    // classe courante de l'élève, ici klass).
    await addGrade(ana.id, maths.id, 'composition', 16);

    // Réinscription en cours de période : Ana change de classe, son
    // historique déjà noté ne doit pas suivre.
    await prisma.student.update({ where: { id: ana.id }, data: { classId: otherClass.id } });

    const nouvelleClasse = await computeClassBulletin(school.id, otherClass.id, term.id);
    const anaDansNouvelle = nouvelleClasse.students.find((s) => s.studentId === ana.id)!;
    expect(anaDansNouvelle.average).toBeNull();
    expect(anaDansNouvelle.subjects).toHaveLength(0);
  });

  it('refuse une classe ou une période d\'une autre école', async () => {
    const other = await createSchool('ecole-b');
    const otherClass = await prisma.class.create({
      data: { schoolId: other.id, name: '6e B', level: '6e' },
    });
    const otherTerm = await prisma.term.create({
      data: { schoolId: other.id, label: 'T1 B' },
    });

    await expect(computeClassBulletin(school.id, otherClass.id, term.id)).rejects.toThrow();
    await expect(computeClassBulletin(school.id, klass.id, otherTerm.id)).rejects.toThrow();
  });
});

describe('checkDuplicateWarning', () => {
  const context = () => ({
    schoolId: school.id,
    studentId: ana.id,
    subjectId: maths.id,
    gradeTypeId: types.composition!,
    termId: term.id,
  });

  it('ne signale rien sur une première saisie', async () => {
    expect(await checkDuplicateWarning(context())).toBe(false);
  });

  it('signale une seconde saisie identique le même jour', async () => {
    await addGrade(ana.id, maths.id, 'composition', 15);
    expect(await checkDuplicateWarning(context())).toBe(true);
  });

  it('ne signale pas un autre type de note', async () => {
    await addGrade(ana.id, maths.id, 'composition', 15);
    expect(
      await checkDuplicateWarning({ ...context(), gradeTypeId: types.devoir! }),
    ).toBe(false);
  });

  it('ignore la note en cours de modification', async () => {
    const existing = await addGrade(ana.id, maths.id, 'composition', 15);
    expect(await checkDuplicateWarning({ ...context(), excludeGradeId: existing.id })).toBe(false);
  });
});
