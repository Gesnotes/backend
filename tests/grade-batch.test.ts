import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase, seedEvaluation } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number };
let teacherToken: string;
let otherTeacherToken: string;
let parentToken: string;
let klass: { id: number };
let otherClass: { id: number };
let subject: { id: number };
let devoir: { id: number };
let composition: { id: number };
let term: { id: number };
let teacher: { id: number };
let evaluation: { id: number };
let evaluationCompo: { id: number };
let students: { id: number }[];

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');

  teacher = await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });
  const other = await createUser({ schoolId: schoolA.id, email: 'autre@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });

  teacherToken = signAccessToken({ userId: teacher.id, schoolId: schoolA.id, role: 'teacher' });
  otherTeacherToken = signAccessToken({ userId: other.id, schoolId: schoolA.id, role: 'teacher' });
  parentToken = signAccessToken({ userId: parent.id, schoolId: schoolA.id, role: 'parent' });

  klass = await prisma.class.create({ data: { schoolId: schoolA.id, name: '3e A', level: '3e' } });
  otherClass = await prisma.class.create({
    data: { schoolId: schoolA.id, name: '6e A', level: '6e' },
  });
  subject = await prisma.subject.create({
    data: { schoolId: schoolA.id, name: 'Maths', coefficient: 5 },
  });
  devoir = await prisma.gradeType.create({
    data: { schoolId: schoolA.id, code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
  });
  composition = await prisma.gradeType.create({
    data: { schoolId: schoolA.id, code: 'composition', label: 'Composition', weight: 3, position: 3 },
  });
  term = await prisma.term.create({ data: { schoolId: schoolA.id, label: 'Trimestre 1' } });

  await prisma.teacherAssignment.create({
    data: {
      schoolId: schoolA.id,
      teacherUserId: teacher.id,
      classId: klass.id,
      subjectId: subject.id,
    },
  });

  // Deux évaluations : un devoir (support de la plupart des cas) et une
  // composition (pour vérifier que deux évaluations distinctes ne se mêlent pas).
  evaluation = await seedEvaluation({
    schoolId: schoolA.id,
    classId: klass.id,
    subjectId: subject.id,
    gradeTypeId: devoir.id,
    termId: term.id,
    teacherUserId: teacher.id,
    label: 'Devoir du 12/09',
  });
  evaluationCompo = await seedEvaluation({
    schoolId: schoolA.id,
    classId: klass.id,
    subjectId: subject.id,
    gradeTypeId: composition.id,
    termId: term.id,
    teacherUserId: teacher.id,
    label: 'Composition du trimestre',
  });

  students = [];
  for (const name of ['Adjovi', 'Kossi', 'Mawuena']) {
    students.push(
      await prisma.student.create({
        data: { schoolId: schoolA.id, classId: klass.id, firstName: name, lastName: 'Test' },
      }),
    );
  }
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string, subdomain = 'ecole-a') =>
  request(app).put('/teachers/me/grades').set('X-School-Subdomain', subdomain).set('Authorization', `Bearer ${token}`);

const batch = (
  entries: { studentId: number; value: number | null; comment?: string | null }[],
  evaluationId = evaluation.id,
) => ({ evaluationId, entries });

describe('PUT /teachers/me/grades', () => {
  it('crée les notes de toute la classe en une requête', async () => {
    const res = await api(teacherToken).send(
      batch(students.map((s, i) => ({ studentId: s.id, value: 10 + i }))),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 3, updated: 0, deleted: 0, unchanged: 0 });
    expect(await prisma.grade.count()).toBe(3);
  });

  /**
   * Le cœur de l'affaire : un lot réémis après une coupure réseau ne doit pas
   * doubler les notes. C'est ce qui autorise le client à rejouer sans risque.
   */
  it('est idempotent : rejouer le même lot ne crée aucun doublon', async () => {
    const payload = batch(students.map((s) => ({ studentId: s.id, value: 12 })));

    await api(teacherToken).send(payload);
    const second = await api(teacherToken).send(payload);

    expect(second.body).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(await prisma.grade.count()).toBe(3);
  });

  it('met à jour les valeurs modifiées et laisse les autres intactes', async () => {
    await api(teacherToken).send(batch(students.map((s) => ({ studentId: s.id, value: 12 }))));

    const res = await api(teacherToken).send(
      batch([
        { studentId: students[0]!.id, value: 18 },
        { studentId: students[1]!.id, value: 12 },
        { studentId: students[2]!.id, value: 12 },
      ]),
    );

    expect(res.body).toMatchObject({ created: 0, updated: 1, unchanged: 2 });

    const updated = await prisma.grade.findFirst({ where: { studentId: students[0]!.id } });
    expect(Number(updated?.value)).toBe(18);
  });

  it('supprime la note quand la valeur est nulle', async () => {
    await api(teacherToken).send(batch(students.map((s) => ({ studentId: s.id, value: 12 }))));

    const res = await api(teacherToken).send(
      batch([
        { studentId: students[0]!.id, value: null },
        { studentId: students[1]!.id, value: 12 },
        { studentId: students[2]!.id, value: 12 },
      ]),
    );

    expect(res.body).toMatchObject({ deleted: 1, unchanged: 2 });
    expect(await prisma.grade.count()).toBe(2);
  });

  it('enregistre les commentaires', async () => {
    await api(teacherToken).send(
      batch([{ studentId: students[0]!.id, value: 16, comment: 'Excellent devoir.' }]),
    );

    const grade = await prisma.grade.findFirst({ where: { studentId: students[0]!.id } });
    expect(grade?.comment).toBe('Excellent devoir.');
  });

  /**
   * Une valeur hors barème au milieu du lot ne doit rien laisser derrière
   * elle : sinon l'enseignant se retrouve avec une saisie à moitié passée
   * sans savoir laquelle.
   */
  it('n’écrit rien si une seule note est hors barème', async () => {
    const res = await api(teacherToken).send(
      batch([
        { studentId: students[0]!.id, value: 15 },
        { studentId: students[1]!.id, value: 25 },
      ]),
    );

    expect(res.status).toBe(400);
    expect(await prisma.grade.count()).toBe(0);
  });

  it('refuse un élève présent deux fois dans le lot', async () => {
    const res = await api(teacherToken).send(
      batch([
        { studentId: students[0]!.id, value: 10 },
        { studentId: students[0]!.id, value: 15 },
      ]),
    );

    expect(res.status).toBe(400);
    expect(await prisma.grade.count()).toBe(0);
  });

  it('signale les élèves d’une autre classe sans échouer', async () => {
    const outsider = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: otherClass.id, firstName: 'Hors', lastName: 'Classe' },
    });

    const res = await api(teacherToken).send(
      batch([
        { studentId: students[0]!.id, value: 14 },
        { studentId: outsider.id, value: 14 },
      ]),
    );

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toEqual([{ studentId: outsider.id, reason: 'eleve_hors_classe' }]);
  });

  /**
   * Le cœur de la fonctionnalité : deux évaluations du **même type** (deux
   * devoirs) coexistent. Chacune a sa propre grille, sans que l'une écrase
   * l'autre — ce qui était impossible tant que l'identité d'une note était son
   * type.
   */
  it('permet deux évaluations du même type pour le même élève', async () => {
    const second = await seedEvaluation({
      schoolId: schoolA.id,
      classId: klass.id,
      subjectId: subject.id,
      gradeTypeId: devoir.id,
      termId: term.id,
      teacherUserId: teacher.id,
      label: 'Devoir du 3/10',
    });

    await api(teacherToken).send(batch([{ studentId: students[0]!.id, value: 10 }]));
    const res = await api(teacherToken).send(
      batch([{ studentId: students[0]!.id, value: 14 }], second.id),
    );

    expect(res.body).toMatchObject({ created: 1 });
    const values = (
      await prisma.grade.findMany({ where: { studentId: students[0]!.id, gradeTypeId: devoir.id } })
    )
      .map((g) => Number(g.value))
      .sort();
    expect(values).toEqual([10, 14]);
  });

  it('ne confond pas deux évaluations distinctes', async () => {
    await api(teacherToken).send(batch([{ studentId: students[0]!.id, value: 12 }]));

    const res = await api(teacherToken).send(
      batch([{ studentId: students[0]!.id, value: 18 }], evaluationCompo.id),
    );

    expect(res.body).toMatchObject({ created: 1 });
    expect(await prisma.grade.count()).toBe(2);
  });

  it('ignore un élève archivé', async () => {
    await prisma.student.update({
      where: { id: students[0]!.id },
      data: { archivedAt: new Date() },
    });

    const res = await api(teacherToken).send(
      batch([{ studentId: students[0]!.id, value: 14 }]),
    );

    expect(res.body.created).toBe(0);
    expect(res.body.skipped[0].reason).toBe('eleve_hors_classe');
  });

  it('refuse un enseignant non affecté à ce couple classe × matière', async () => {
    const res = await api(otherTeacherToken).send(
      batch([{ studentId: students[0]!.id, value: 14 }]),
    );
    expect(res.status).toBe(403);
  });

  it('refuse un parent', async () => {
    const res = await api(parentToken).send(batch([{ studentId: students[0]!.id, value: 14 }]));
    expect(res.status).toBe(403);
  });

  it('refuse une évaluation inconnue', async () => {
    const res = await api(teacherToken).send(
      batch([{ studentId: students[0]!.id, value: 1 }], 999999),
    );
    expect(res.status).toBe(404);
  });

  it('valide la forme du corps', async () => {
    expect((await api(teacherToken).send({ entries: [] })).status).toBe(400);
    expect((await api(teacherToken).send({ ...batch([]), entries: [] })).status).toBe(400);
  });
});
