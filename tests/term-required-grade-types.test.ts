import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, resetDatabase, seedGrade } from './helpers';
import { createTerm } from '../src/services/term.service';
import { computeStudentResult } from '../src/services/grading/grading.service';
import { updateGradeType } from '../src/services/gradeType.service';

/**
 * `TermRequiredGradeType` fige, à la création de chaque période, quels types
 * de note sont alors obligatoires — pas une lecture en direct de
 * `GradeType.required`. Ces tests vérifient précisément la propriété qui
 * justifie cette table : un changement de configuration après coup ne doit
 * jamais changer le caractère complet d'un bulletin déjà calculable pour une
 * période déjà créée.
 */

let school: { id: number };
let klass: { id: number };
let subject: { id: number };
let student: { id: number };
let devoir: { id: number };

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');
  klass = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  subject = await prisma.subject.create({ data: { schoolId: school.id, name: 'Maths', coefficient: 4 } });
  student = await prisma.student.create({
    data: { schoolId: school.id, classId: klass.id, firstName: 'Ana', lastName: 'Alpha' },
  });
  devoir = await prisma.gradeType.create({
    data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, required: true },
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('photographie des types obligatoires à la création de la période', () => {
  it("n'attend rien qui n'était pas obligatoire au moment de sa création", async () => {
    const interrogation = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'interrogation', label: 'Interrogation', weight: 1, required: false },
    });

    const term = await createTerm(school.id, { label: 'Trimestre 1' });
    await seedGrade({
      schoolId: school.id,
      studentId: student.id,
      subjectId: subject.id,
      gradeTypeId: interrogation.id,
      termId: term.id,
      value: 12,
    });

    // "devoir" est obligatoire (required: true) mais n'a aucune note ici :
    // sans photographie, la moyenne serait publiée quand même à tort.
    const result = await computeStudentResult(school.id, student.id, term.id);
    expect(result.subjects[0]!.average).toBeNull();
  });

  it("ne rend jamais rétroactivement publiable une moyenne déjà incomplète, quand le type qui manquait cesse d'être obligatoire", async () => {
    const interrogation = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'interrogation', label: 'Interrogation', weight: 1, required: false },
    });

    // "devoir" est obligatoire dès la création de la période (beforeEach).
    const term = await createTerm(school.id, { label: 'Trimestre 1' });
    await seedGrade({
      schoolId: school.id,
      studentId: student.id,
      subjectId: subject.id,
      gradeTypeId: interrogation.id,
      termId: term.id,
      value: 12,
    });

    // Toujours aucune note "devoir" : la moyenne reste incomplète (vérifié
    // par le premier test de ce bloc). L'administration change ensuite d'avis
    // et rend "devoir" facultatif.
    await updateGradeType(school.id, devoir.id, { required: false });

    // La photographie prise à la création de cette période dit toujours
    // "devoir" obligatoire — le changement de configuration ne doit rien
    // changer pour une période déjà créée, même si "devoir" ne l'est plus
    // en direct.
    const result = await computeStudentResult(school.id, student.id, term.id);
    expect(result.subjects[0]!.average).toBeNull();
  });

  it('applique la configuration à jour à toute période créée après le changement', async () => {
    // "devoir" est obligatoire au départ (beforeEach) ; on le rend facultatif
    // avant de créer la période.
    await updateGradeType(school.id, devoir.id, { required: false });

    const interrogation = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'interrogation', label: 'Interrogation', weight: 1, required: false },
    });
    const term = await createTerm(school.id, { label: 'Trimestre 2' });
    await seedGrade({
      schoolId: school.id,
      studentId: student.id,
      subjectId: subject.id,
      gradeTypeId: interrogation.id,
      termId: term.id,
      value: 12,
    });

    // "devoir" n'était déjà plus obligatoire quand cette période a été créée :
    // une seule note d'interrogation suffit à publier la moyenne.
    const result = await computeStudentResult(school.id, student.id, term.id);
    expect(result.subjects[0]!.average).toBe(12);
  });

  it('exclut un type obligatoire mais déjà archivé au moment de la création', async () => {
    await prisma.gradeType.update({ where: { id: devoir.id }, data: { archivedAt: new Date() } });

    const interrogation = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'interrogation', label: 'Interrogation', weight: 1, required: false },
    });
    const term = await createTerm(school.id, { label: 'Trimestre 1' });
    await seedGrade({
      schoolId: school.id,
      studentId: student.id,
      subjectId: subject.id,
      gradeTypeId: interrogation.id,
      termId: term.id,
      value: 12,
    });

    const result = await computeStudentResult(school.id, student.id, term.id);
    expect(result.subjects[0]!.average).toBe(12);
  });
});
