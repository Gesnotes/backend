import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase } from './helpers';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let school: { id: number };
let profA: { id: number };
let profB: { id: number };
let tokenProfA: string;
let tokenProfB: string;
let tokenAdmin: string;
let tokenParent: string;
let classe6: { id: number };
let classe5: { id: number };
let maths: { id: number };
let francais: { id: number };
let term: { id: number };
let devoirId: number;
let compoId: number;
let ana: { id: number };

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');

  const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  profA = await createUser({ schoolId: school.id, email: 'profa@a.test', role: 'teacher' });
  profB = await createUser({ schoolId: school.id, email: 'profb@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: school.id, email: 'parent@a.test', role: 'parent' });

  tokenAdmin = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
  tokenProfA = signAccessToken({ userId: profA.id, schoolId: school.id, role: 'teacher' });
  tokenProfB = signAccessToken({ userId: profB.id, schoolId: school.id, role: 'teacher' });
  tokenParent = signAccessToken({ userId: parent.id, schoolId: school.id, role: 'parent' });

  classe6 = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  classe5 = await prisma.class.create({ data: { schoolId: school.id, name: '5e A', level: '5e' } });
  maths = await prisma.subject.create({ data: { schoolId: school.id, name: 'Maths' } });
  francais = await prisma.subject.create({ data: { schoolId: school.id, name: 'Français' } });
  term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });

  const [devoir, compo] = await Promise.all([
    prisma.gradeType.create({
      data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
    }),
    prisma.gradeType.create({
      data: { schoolId: school.id, code: 'composition', label: 'Composition', weight: 3, position: 3 },
    }),
  ]);
  devoirId = devoir.id;
  compoId = compo.id;

  // Prof A enseigne les maths en 6e A ; prof B le français en 5e A.
  await prisma.teacherAssignment.create({
    data: { teacherUserId: profA.id, classId: classe6.id, subjectId: maths.id },
  });
  await prisma.teacherAssignment.create({
    data: { teacherUserId: profB.id, classId: classe5.id, subjectId: francais.id },
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
  get: (p: string) => request(app).get(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
  patch: (p: string) => request(app).patch(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
  delete: (p: string) => request(app).delete(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
});

const payload = (over: Record<string, unknown> = {}) => ({
  studentId: ana.id,
  subjectId: maths.id,
  gradeTypeId: devoirId,
  termId: term.id,
  value: 15,
  ...over,
});

/**
 * Le bloc le plus important du projet : un enseignant ne doit jamais pouvoir
 * agir sur les notes d'un collègue. Les cinq routes passent par la même
 * fonction `assertCanGrade` — ces tests vérifient qu'aucune n'a été oubliée.
 */
describe('permissions de saisie (assertCanGrade)', () => {
  it('autorise le prof sur sa classe et sa matière', async () => {
    const res = await api(tokenProfA).post('/grades').send(payload());
    expect(res.status).toBe(201);
    expect(res.body.note.value).toBe(15);
  });

  it('REFUSE la création sur la classe d\'un collègue', async () => {
    const res = await api(tokenProfB).post('/grades').send(payload());
    expect(res.status).toBe(403);
    expect(await prisma.grade.count()).toBe(0);
  });

  it('REFUSE une matière que le prof n\'enseigne pas dans cette classe', async () => {
    const res = await api(tokenProfA).post('/grades').send(payload({ subjectId: francais.id }));
    expect(res.status).toBe(403);
  });

  it('REFUSE la modification de la note d\'un collègue', async () => {
    const { body } = await api(tokenProfA).post('/grades').send(payload());

    const res = await api(tokenProfB).patch(`/grades/${body.note.id}`).send({ value: 20 });
    expect(res.status).toBe(403);

    const unchanged = await prisma.grade.findUniqueOrThrow({ where: { id: body.note.id } });
    expect(Number(unchanged.value)).toBe(15);
  });

  it('REFUSE la suppression de la note d\'un collègue', async () => {
    const { body } = await api(tokenProfA).post('/grades').send(payload());

    expect((await api(tokenProfB).delete(`/grades/${body.note.id}`)).status).toBe(403);
    expect(await prisma.grade.count()).toBe(1);
  });

  it('REFUSE la table de saisie sur la classe d\'un collègue', async () => {
    const res = await api(tokenProfB).get(
      `/teachers/me/grades?class_id=${classe6.id}&subject_id=${maths.id}&term_id=${term.id}`,
    );
    expect(res.status).toBe(403);
  });

  it('refuse toute saisie à un parent', async () => {
    expect((await api(tokenParent).post('/grades').send(payload())).status).toBe(403);
  });

  it("laisse l'admin agir sans affectation, dans son école", async () => {
    const res = await api(tokenAdmin).post('/grades').send(payload({ subjectId: francais.id }));
    expect(res.status).toBe(201);
  });

  it("refuse un élève d'une autre école", async () => {
    const other = await createSchool('ecole-b');
    const otherClass = await prisma.class.create({
      data: { schoolId: other.id, name: '6e B', level: '6e' },
    });
    const foreign = await prisma.student.create({
      data: { schoolId: other.id, classId: otherClass.id, firstName: 'X', lastName: 'Y' },
    });

    const res = await api(tokenAdmin).post('/grades').send(payload({ studentId: foreign.id }));
    expect(res.status).toBe(404);
  });
});

describe('validation de la saisie', () => {
  it('refuse une note supérieure au maximum', async () => {
    const res = await api(tokenProfA).post('/grades').send(payload({ value: 21 }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.maxValue).toBe(20);
  });

  it('refuse une note négative', async () => {
    expect((await api(tokenProfA).post('/grades').send(payload({ value: -1 }))).status).toBe(400);
  });

  it('accepte une note sur une autre échelle', async () => {
    const res = await api(tokenProfA).post('/grades').send(payload({ value: 8, maxValue: 10 }));
    expect(res.status).toBe(201);
    expect(res.body.note.maxValue).toBe(10);
  });

  it('refuse 8/10 déclaré sur 5', async () => {
    expect((await api(tokenProfA).post('/grades').send(payload({ value: 8, maxValue: 5 }))).status).toBe(400);
  });

  it("refuse une période ou un type d'une autre école", async () => {
    const other = await createSchool('ecole-b');
    const foreignTerm = await prisma.term.create({ data: { schoolId: other.id, label: 'T1' } });
    const foreignType = await prisma.gradeType.create({
      data: { schoolId: other.id, code: 'devoir', label: 'Devoir', weight: 2 },
    });

    expect((await api(tokenProfA).post('/grades').send(payload({ termId: foreignTerm.id }))).status).toBe(404);
    expect((await api(tokenProfA).post('/grades').send(payload({ gradeTypeId: foreignType.id }))).status).toBe(404);
  });

  it('refuse une saisie sur un élève archivé', async () => {
    await prisma.student.update({ where: { id: ana.id }, data: { archivedAt: new Date() } });
    expect((await api(tokenProfA).post('/grades').send(payload())).status).toBe(404);
  });
});

describe('commentaire et doublon', () => {
  it('enregistre le commentaire du professeur', async () => {
    const res = await api(tokenProfA)
      .post('/grades')
      .send(payload({ comment: 'Bon travail, continue.' }));

    expect(res.body.note.comment).toBe('Bon travail, continue.');
  });

  it('signale un doublon sans bloquer la saisie', async () => {
    const first = await api(tokenProfA).post('/grades').send(payload({ gradeTypeId: compoId }));
    expect(first.body.avertissementDoublon).toBe(false);

    const second = await api(tokenProfA).post('/grades').send(payload({ gradeTypeId: compoId }));
    expect(second.status).toBe(201);
    expect(second.body.avertissementDoublon).toBe(true);
    expect(await prisma.grade.count()).toBe(2);
  });

  it('ne signale rien pour un type de note différent', async () => {
    await api(tokenProfA).post('/grades').send(payload({ gradeTypeId: devoirId }));
    const autre = await api(tokenProfA).post('/grades').send(payload({ gradeTypeId: compoId }));
    expect(autre.body.avertissementDoublon).toBe(false);
  });
});

describe('modification et suppression', () => {
  it('modifie valeur, type et commentaire', async () => {
    const { body } = await api(tokenProfA).post('/grades').send(payload());

    const res = await api(tokenProfA)
      .patch(`/grades/${body.note.id}`)
      .send({ value: 18, gradeTypeId: compoId, comment: 'Excellent' });

    expect(res.status).toBe(200);
    expect(res.body.value).toBe(18);
    expect(res.body.type.code).toBe('composition');
    expect(res.body.comment).toBe('Excellent');
  });

  it('valide la nouvelle valeur contre le maximum existant', async () => {
    const { body } = await api(tokenProfA).post('/grades').send(payload({ value: 8, maxValue: 10 }));
    expect((await api(tokenProfA).patch(`/grades/${body.note.id}`).send({ value: 15 })).status).toBe(400);
  });

  it('efface un commentaire avec null', async () => {
    const { body } = await api(tokenProfA).post('/grades').send(payload({ comment: 'À revoir' }));
    const res = await api(tokenProfA).patch(`/grades/${body.note.id}`).send({ comment: null });
    expect(res.body.comment).toBeNull();
  });

  it('supprime une note', async () => {
    const { body } = await api(tokenProfA).post('/grades').send(payload());
    expect((await api(tokenProfA).delete(`/grades/${body.note.id}`)).status).toBe(204);
    expect(await prisma.grade.count()).toBe(0);
  });
});

describe('GET /teachers/me/classes', () => {
  it('liste mes affectations avec la progression de saisie', async () => {
    await prisma.student.create({
      data: { schoolId: school.id, classId: classe6.id, firstName: 'Ben', lastName: 'Beta' },
    });
    await api(tokenProfA).post('/grades').send(payload());

    const res = await api(tokenProfA).get('/teachers/me/classes');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      className: '6e A',
      subjectName: 'Maths',
      effectif: 2,
      evalues: 1,
    });
  });

  it("ne montre jamais les affectations d'un collègue", async () => {
    const res = await api(tokenProfB).get('/teachers/me/classes');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].subjectName).toBe('Français');
  });

  it('compte les élèves évalués, pas les notes saisies', async () => {
    await api(tokenProfA).post('/grades').send(payload({ gradeTypeId: devoirId }));
    await api(tokenProfA).post('/grades').send(payload({ gradeTypeId: compoId }));

    const res = await api(tokenProfA).get('/teachers/me/classes');
    expect(res.body[0].evalues).toBe(1);
  });
});

describe('table de saisie et historique', () => {
  it('renvoie tous les élèves, même sans note', async () => {
    await prisma.student.create({
      data: { schoolId: school.id, classId: classe6.id, firstName: 'Ben', lastName: 'Beta' },
    });
    await api(tokenProfA).post('/grades').send(payload());

    const res = await api(tokenProfA).get(
      `/teachers/me/grades?class_id=${classe6.id}&subject_id=${maths.id}&term_id=${term.id}`,
    );

    expect(res.body).toHaveLength(2);
    expect(res.body.find((s: { firstName: string }) => s.firstName === 'Ana').notes).toHaveLength(1);
    expect(res.body.find((s: { firstName: string }) => s.firstName === 'Ben').notes).toHaveLength(0);
  });

  it('exclut les élèves archivés de la table de saisie', async () => {
    await prisma.student.update({ where: { id: ana.id }, data: { archivedAt: new Date() } });
    const res = await api(tokenProfA).get(
      `/teachers/me/grades?class_id=${classe6.id}&subject_id=${maths.id}&term_id=${term.id}`,
    );
    expect(res.body).toHaveLength(0);
  });

  it("l'historique ne contient que mes propres saisies", async () => {
    await api(tokenProfA).post('/grades').send(payload());
    await api(tokenAdmin).post('/grades').send(payload({ subjectId: francais.id }));

    const res = await api(tokenProfA).get('/teachers/me/grades/history');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].matiere.name).toBe('Maths');
    expect(res.body[0].eleve.firstName).toBe('Ana');
  });

  it('filtre l\'historique par classe et période', async () => {
    await api(tokenProfA).post('/grades').send(payload());

    expect((await api(tokenProfA).get(`/teachers/me/grades/history?class_id=${classe6.id}`)).body).toHaveLength(1);
    expect((await api(tokenProfA).get(`/teachers/me/grades/history?class_id=${classe5.id}`)).body).toHaveLength(0);
  });
});
