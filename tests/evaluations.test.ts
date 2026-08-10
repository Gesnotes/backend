import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase, seedEvaluation, seedGrade } from './helpers';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let school: { id: number };
let profA: { id: number };
let tokenProfA: string;
let tokenProfB: string;
let tokenAdmin: string;
let tokenParent: string;
let classe6: { id: number };
let maths: { id: number };
let francais: { id: number };
let term: { id: number };
let devoirId: number;
let ana: { id: number };

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');

  const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  profA = await createUser({ schoolId: school.id, email: 'profa@a.test', role: 'teacher' });
  const profB = await createUser({ schoolId: school.id, email: 'profb@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: school.id, email: 'parent@a.test', role: 'parent' });

  tokenAdmin = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
  tokenProfA = signAccessToken({ userId: profA.id, schoolId: school.id, role: 'teacher' });
  tokenProfB = signAccessToken({ userId: profB.id, schoolId: school.id, role: 'teacher' });
  tokenParent = signAccessToken({ userId: parent.id, schoolId: school.id, role: 'parent' });

  classe6 = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  maths = await prisma.subject.create({ data: { schoolId: school.id, name: 'Maths' } });
  francais = await prisma.subject.create({ data: { schoolId: school.id, name: 'Français' } });
  term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });

  const devoir = await prisma.gradeType.create({
    data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
  });
  devoirId = devoir.id;

  await prisma.teacherAssignment.create({
    data: { schoolId: school.id, teacherUserId: profA.id, classId: classe6.id, subjectId: maths.id },
  });

  ana = await prisma.student.create({
    data: { schoolId: school.id, classId: classe6.id, firstName: 'Ana', lastName: 'Alpha' },
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(p).set('Authorization', `Bearer ${token}`),
  patch: (p: string) => request(app).patch(p).set('Authorization', `Bearer ${token}`),
  delete: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

const body = (over: Record<string, unknown> = {}) => ({
  classId: classe6.id,
  subjectId: maths.id,
  gradeTypeId: devoirId,
  termId: term.id,
  label: 'Interro du 12/09',
  ...over,
});

/**
 * Verrou de trimestre clos, et sa soupape.
 *
 * Un enseignant n'écrit pas sur un trimestre dont la date de fin est passée :
 * les moyennes et les bulletins en dépendent. L'administration garde la main,
 * et peut rouvrir la période jusqu'à une échéance pour un rattrapage.
 */
describe('Trimestre clos', () => {
  /** Rend la période de test terminée, éventuellement rouverte jusqu'à `until`. */
  async function close(until?: Date) {
    const past = new Date();
    past.setDate(past.getDate() - 10);
    await prisma.term.update({
      where: { id: term.id },
      data: {
        startDate: new Date(past.getTime() - 30 * 24 * 60 * 60 * 1000),
        endDate: past,
        reopenedUntil: until ?? null,
      },
    });
  }

  it('interdit à un enseignant de créer une évaluation', async () => {
    await close();

    const res = await api(tokenProfA).post('/teachers/me/evaluations').send(body());

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/terminé/i);
  });

  it('laisse l’administration corriger malgré la clôture', async () => {
    await close();

    const res = await api(tokenAdmin).post('/teachers/me/evaluations').send(body());

    expect(res.status).toBe(201);
  });

  it('rouvre la saisie à l’enseignant jusqu’à l’échéance', async () => {
    await close(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));

    const res = await api(tokenProfA).post('/teachers/me/evaluations').send(body());

    expect(res.status).toBe(201);
  });

  it('referme la saisie une fois l’échéance passée', async () => {
    await close(new Date(Date.now() - 60_000));

    const res = await api(tokenProfA).post('/teachers/me/evaluations').send(body());

    expect(res.status).toBe(403);
  });

  it('interdit aussi la modification d’une évaluation existante', async () => {
    const evaluation = await seedEvaluation({
      schoolId: school.id,
      classId: classe6.id,
      subjectId: maths.id,
      gradeTypeId: devoirId,
      termId: term.id,
    });
    await close();

    const res = await api(tokenProfA).patch(`/evaluations/${evaluation.id}`).send({ label: 'Renommée' });

    expect(res.status).toBe(403);
  });
});

describe('POST /teachers/me/evaluations', () => {
  it('crée une évaluation sur sa classe et sa matière', async () => {
    const res = await api(tokenProfA).post('/teachers/me/evaluations').send(body({ maxValue: 10 }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ label: 'Interro du 12/09', maxValue: 10 });
    expect(res.body.type.code).toBe('devoir');
  });

  it('refuse un prof non affecté à ce couple classe × matière', async () => {
    const res = await api(tokenProfA).post('/teachers/me/evaluations').send(body({ subjectId: francais.id }));
    expect(res.status).toBe(403);
  });

  it('refuse un type ou une période d\'une autre école', async () => {
    const other = await createSchool('ecole-b');
    const foreignTerm = await prisma.term.create({ data: { schoolId: other.id, label: 'T1' } });
    const foreignType = await prisma.gradeType.create({
      data: { schoolId: other.id, code: 'devoir', label: 'Devoir', weight: 2 },
    });

    expect((await api(tokenAdmin).post('/teachers/me/evaluations').send(body({ termId: foreignTerm.id }))).status).toBe(404);
    expect((await api(tokenAdmin).post('/teachers/me/evaluations').send(body({ gradeTypeId: foreignType.id }))).status).toBe(404);
  });

  it('refuse un parent', async () => {
    expect((await api(tokenParent).post('/teachers/me/evaluations').send(body())).status).toBe(403);
  });

  it('valide le corps', async () => {
    expect((await api(tokenProfA).post('/teachers/me/evaluations').send(body({ label: '' }))).status).toBe(400);
  });
});

describe('GET /teachers/me/evaluations', () => {
  it('liste les évaluations du contexte, la plus récente en tête', async () => {
    await seedEvaluation({
      schoolId: school.id, classId: classe6.id, subjectId: maths.id,
      gradeTypeId: devoirId, termId: term.id, label: 'Interro 1', date: new Date('2026-09-12'),
    });
    await seedEvaluation({
      schoolId: school.id, classId: classe6.id, subjectId: maths.id,
      gradeTypeId: devoirId, termId: term.id, label: 'Interro 2', date: new Date('2026-10-03'),
    });

    const res = await api(tokenProfA).get(
      `/teachers/me/evaluations?class_id=${classe6.id}&subject_id=${maths.id}&term_id=${term.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((e: { label: string }) => e.label)).toEqual(['Interro 2', 'Interro 1']);
  });

  it('refuse la lecture sur une classe non enseignée', async () => {
    const res = await api(tokenProfB).get(
      `/teachers/me/evaluations?class_id=${classe6.id}&subject_id=${maths.id}&term_id=${term.id}`,
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /evaluations/:id', () => {
  it('renomme et re-date', async () => {
    const evaluation = await seedEvaluation({
      schoolId: school.id, classId: classe6.id, subjectId: maths.id,
      gradeTypeId: devoirId, termId: term.id, label: 'Brouillon',
    });

    const res = await api(tokenProfA).patch(`/evaluations/${evaluation.id}`).send({
      label: 'Interro finale',
      date: '2026-09-12',
    });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Interro finale');
  });

  it('propage le nouveau barème aux notes existantes', async () => {
    const evaluation = await seedEvaluation({
      schoolId: school.id, classId: classe6.id, subjectId: maths.id,
      gradeTypeId: devoirId, termId: term.id, maxValue: 20,
    });
    await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, value: 8, maxValue: 20, evaluationId: evaluation.id,
    });

    const res = await api(tokenProfA).patch(`/evaluations/${evaluation.id}`).send({ maxValue: 10 });
    expect(res.status).toBe(200);

    const grade = await prisma.grade.findFirstOrThrow({ where: { evaluationId: evaluation.id } });
    expect(Number(grade.maxValue)).toBe(10);
  });

  it('refuse un barème inférieur à une note déjà saisie', async () => {
    const evaluation = await seedEvaluation({
      schoolId: school.id, classId: classe6.id, subjectId: maths.id,
      gradeTypeId: devoirId, termId: term.id, maxValue: 20,
    });
    await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, value: 15, maxValue: 20, evaluationId: evaluation.id,
    });

    expect((await api(tokenProfA).patch(`/evaluations/${evaluation.id}`).send({ maxValue: 10 })).status).toBe(400);
  });
});

describe('DELETE /evaluations/:id', () => {
  it('supprime l\'évaluation et ses notes en cascade', async () => {
    const evaluation = await seedEvaluation({
      schoolId: school.id, classId: classe6.id, subjectId: maths.id,
      gradeTypeId: devoirId, termId: term.id,
    });
    await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, value: 12, evaluationId: evaluation.id,
    });

    expect((await api(tokenProfA).delete(`/evaluations/${evaluation.id}`)).status).toBe(204);
    expect(await prisma.evaluation.count()).toBe(0);
    expect(await prisma.grade.count()).toBe(0);
  });

  it('refuse la suppression par un prof non affecté', async () => {
    const evaluation = await seedEvaluation({
      schoolId: school.id, classId: classe6.id, subjectId: maths.id,
      gradeTypeId: devoirId, termId: term.id,
    });
    expect((await api(tokenProfB).delete(`/evaluations/${evaluation.id}`)).status).toBe(403);
  });
});
