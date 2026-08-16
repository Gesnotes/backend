import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase, seedGrade } from './helpers';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number };
let schoolB: { id: number };
let adminToken: string;
let teacherToken: string;
let klass: { id: number };
let term: { id: number };
let maths: { id: number };
let compoId: number;
let devoirId: number;

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: schoolA.id, email: 'prof@a.test', role: 'teacher' });
  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherToken = signAccessToken({ userId: teacher.id, schoolId: schoolA.id, role: 'teacher' });

  klass = await prisma.class.create({ data: { schoolId: schoolA.id, name: '6e A', level: '6e' } });
  term = await prisma.term.create({ data: { schoolId: schoolA.id, label: 'Trimestre 1' } });
  maths = await prisma.subject.create({
    data: { schoolId: schoolA.id, name: 'Maths', coefficient: 2 },
  });
  const compo = await prisma.gradeType.create({
    data: { schoolId: schoolA.id, code: 'composition', label: 'Composition', weight: 3 },
  });
  compoId = compo.id;
  const devoir = await prisma.gradeType.create({
    data: { schoolId: schoolA.id, code: 'devoir', label: 'Devoir', weight: 2 },
  });
  devoirId = devoir.id;
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

const addStudent = (firstName: string, lastName: string, classId = klass.id) =>
  prisma.student.create({ data: { schoolId: schoolA.id, classId, firstName, lastName } });

/**
 * Devoir et composition à la même valeur : la moyenne pondérée d'un devoir et
 * d'une composition identiques vaut cette valeur, quels que soient leurs
 * poids respectifs — ça permet à ces tests de continuer à raisonner sur "la
 * note de l'élève" comme une valeur unique, tout en passant le seuil de
 * publication (devoir + composition requis).
 */
const addGrade = async (studentId: number, value: number) => {
  await seedGrade({
    schoolId: schoolA.id,
    studentId,
    subjectId: maths.id,
    gradeTypeId: devoirId,
    termId: term.id,
    value,
  });
  return seedGrade({
    schoolId: schoolA.id,
    studentId,
    subjectId: maths.id,
    gradeTypeId: compoId,
    termId: term.id,
    value,
  });
};

describe('CRUD /classes', () => {
  it('crée, liste et modifie une classe', async () => {
    const created = await api(adminToken).post('/classes').send({ name: '5e A', level: '5e' });
    expect(created.status).toBe(201);

    const list = await api(adminToken).get('/classes');
    expect(list.body).toHaveLength(2);

    const updated = await api(adminToken).patch(`/classes/${created.body.id}`).send({ name: '5e B' });
    expect(updated.body.name).toBe('5e B');
  });

  it('exige un nom et un niveau', async () => {
    expect((await api(adminToken).post('/classes').send({ name: '5e A' })).status).toBe(400);
    expect((await api(adminToken).post('/classes').send({ level: '5e' })).status).toBe(400);
  });

  it('interdit la création à un enseignant', async () => {
    const res = await api(teacherToken).post('/classes').send({ name: '5e A', level: '5e' });
    expect(res.status).toBe(403);
  });

  it("renvoie l'effectif sans compter les élèves archivés", async () => {
    await addStudent('Ana', 'Alpha');
    const ben = await addStudent('Ben', 'Beta');
    await prisma.student.update({ where: { id: ben.id }, data: { archivedAt: new Date() } });

    const list = await api(adminToken).get('/classes');
    expect(list.body[0].effectif).toBe(1);
  });

  it('ne renvoie pas de moyenne sans période précisée', async () => {
    const ana = await addStudent('Ana', 'Alpha');
    await addGrade(ana.id, 15);

    const list = await api(adminToken).get('/classes');
    expect(list.body[0].average).toBeNull();

    const withTerm = await api(adminToken).get(`/classes?term_id=${term.id}`);
    expect(withTerm.body[0].average).toBe(15);
  });

  it("renvoie le nombre d'élèves évalués, seulement avec une période", async () => {
    const ana = await addStudent('Ana', 'Alpha');
    await addStudent('Ben', 'Beta'); // pas noté
    await addGrade(ana.id, 15);

    const list = await api(adminToken).get('/classes');
    expect(list.body[0].evalues).toBeNull();

    const withTerm = await api(adminToken).get(`/classes?term_id=${term.id}`);
    expect(withTerm.body[0].evalues).toBe(1);
    expect(withTerm.body[0].effectif).toBe(2);
  });
});

describe('mode par classe et enseignant référent', () => {
  it('crée une classe en mode notes par défaut', async () => {
    const res = await api(adminToken).post('/classes').send({ name: '5e A', level: '5e' });
    expect(res.body.mode).toBe('notes');
    expect(res.body.homeroomTeacherId).toBeNull();
  });

  it('crée une classe en mode présence avec un référent', async () => {
    const prof = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });

    const res = await api(adminToken)
      .post('/classes')
      .send({ name: 'Petite section', level: 'maternelle', mode: 'presence', homeroomTeacherId: prof.id });

    expect(res.status).toBe(201);
    expect(res.body.mode).toBe('presence');
    expect(res.body.homeroomTeacherId).toBe(prof.id);
  });

  it("refuse un référent qui n'est pas un enseignant de l'école", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@a.test' } });
    const foreignTeacher = await createUser({
      schoolId: schoolB.id,
      email: 'prof@b.test',
      role: 'teacher',
    });

    expect(
      (await api(adminToken).post('/classes').send({ name: '5e A', level: '5e', homeroomTeacherId: admin.id }))
        .status,
    ).toBe(404);
    expect(
      (
        await api(adminToken)
          .post('/classes')
          .send({ name: '5e A', level: '5e', homeroomTeacherId: foreignTeacher.id })
      ).status,
    ).toBe(404);
  });

  it('modifie le référent, puis le retire', async () => {
    const prof = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });

    await api(adminToken).patch(`/classes/${klass.id}`).send({ homeroomTeacherId: prof.id });
    const withReferent = await prisma.class.findUniqueOrThrow({ where: { id: klass.id } });
    expect(withReferent.homeroomTeacherId).toBe(prof.id);

    await api(adminToken).patch(`/classes/${klass.id}`).send({ homeroomTeacherId: null });
    const withoutReferent = await prisma.class.findUniqueOrThrow({ where: { id: klass.id } });
    expect(withoutReferent.homeroomTeacherId).toBeNull();
  });

  it('refuse de passer en mode présence une classe qui a déjà des évaluations', async () => {
    const ana = await addStudent('Ana', 'Alpha');
    await addGrade(ana.id, 12);

    const res = await api(adminToken).patch(`/classes/${klass.id}`).send({ mode: 'presence' });
    expect(res.status).toBe(409);
    expect(await prisma.class.findUniqueOrThrow({ where: { id: klass.id } })).toMatchObject({
      mode: 'notes',
    });
  });

  it('permet le passage en mode présence sans évaluation existante', async () => {
    const res = await api(adminToken).patch(`/classes/${klass.id}`).send({ mode: 'presence' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('presence');
  });
});

describe('classes rattachées à une année scolaire et classe supérieure', () => {
  const makeYear = (label: string) => prisma.schoolYear.create({ data: { schoolId: schoolA.id, label } });

  it('crée une classe rattachée à une année scolaire', async () => {
    const year = await makeYear('2025-2026');

    const res = await api(adminToken)
      .post('/classes')
      .send({ name: '5e A', level: '5e', schoolYearId: year.id });

    expect(res.status).toBe(201);
    expect(res.body.schoolYearId).toBe(year.id);
  });

  it("refuse une année scolaire d'une autre école", async () => {
    const foreignYear = await prisma.schoolYear.create({ data: { schoolId: schoolB.id, label: '2025-2026' } });

    const res = await api(adminToken)
      .post('/classes')
      .send({ name: '5e A', level: '5e', schoolYearId: foreignYear.id });

    expect(res.status).toBe(404);
  });

  it('autorise le même nom de classe dans deux années différentes', async () => {
    const y1 = await makeYear('2025-2026');
    const y2 = await makeYear('2026-2027');

    await api(adminToken).post('/classes').send({ name: '6e A', level: '6e', schoolYearId: y1.id });
    const res = await api(adminToken).post('/classes').send({ name: '6e A', level: '6e', schoolYearId: y2.id });

    expect(res.status).toBe(201);
  });

  it('refuse le même nom de classe deux fois dans la même année', async () => {
    const year = await makeYear('2025-2026');
    await api(adminToken).post('/classes').send({ name: '6e A', level: '6e', schoolYearId: year.id });

    const res = await api(adminToken).post('/classes').send({ name: '6e A', level: '6e', schoolYearId: year.id });
    expect(res.status).toBe(409);
  });

  it('filtre les classes par année scolaire', async () => {
    const year = await makeYear('2025-2026');
    await api(adminToken).post('/classes').send({ name: '6e A', level: '6e', schoolYearId: year.id });
    // `klass` (créée dans beforeEach) n'a pas d'année : elle ne doit pas apparaître dans le filtre.

    const res = await api(adminToken).get(`/classes?school_year_id=${year.id}`);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('6e A');
  });

  it('modifie le rattachement à une année, puis le retire', async () => {
    const year = await makeYear('2025-2026');

    await api(adminToken).patch(`/classes/${klass.id}`).send({ schoolYearId: year.id });
    expect((await prisma.class.findUniqueOrThrow({ where: { id: klass.id } })).schoolYearId).toBe(year.id);

    await api(adminToken).patch(`/classes/${klass.id}`).send({ schoolYearId: null });
    expect((await prisma.class.findUniqueOrThrow({ where: { id: klass.id } })).schoolYearId).toBeNull();
  });

  describe('POST /classes/:id/duplicate — préparer la rentrée suivante', () => {
    it('duplique la classe dans la nouvelle année, coefficients et référent compris', async () => {
      const prof = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
      await api(adminToken).patch(`/classes/${klass.id}`).send({ homeroomTeacherId: prof.id });
      await prisma.subjectCoefficient.create({ data: { subjectId: maths.id, classId: klass.id, coefficient: 4 } });

      const nextYear = await makeYear('2026-2027');
      const res = await api(adminToken).post(`/classes/${klass.id}/duplicate`).send({ schoolYearId: nextYear.id });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: '6e A', level: '6e', schoolYearId: nextYear.id, homeroomTeacherId: prof.id });

      const coefficients = await prisma.subjectCoefficient.findMany({ where: { classId: res.body.id } });
      expect(coefficients).toHaveLength(1);
      expect(Number(coefficients[0]!.coefficient)).toBe(4);

      const source = await prisma.class.findUniqueOrThrow({ where: { id: klass.id } });
      expect(source.promotesToId).toBe(res.body.id);
    });

    it('accepte un nom et un niveau différents', async () => {
      const nextYear = await makeYear('2026-2027');
      const res = await api(adminToken)
        .post(`/classes/${klass.id}/duplicate`)
        .send({ schoolYearId: nextYear.id, name: '5e A', level: '5e' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: '5e A', level: '5e' });
    });

    it('refuse de dupliquer deux fois la même classe', async () => {
      const nextYear = await makeYear('2026-2027');
      await api(adminToken).post(`/classes/${klass.id}/duplicate`).send({ schoolYearId: nextYear.id });

      const res = await api(adminToken).post(`/classes/${klass.id}/duplicate`).send({ schoolYearId: nextYear.id });
      expect(res.status).toBe(409);
    });
  });

  describe('classe supérieure (promotesToId)', () => {
    it('désigne une classe supérieure', async () => {
      const cinquieme = await prisma.class.create({ data: { schoolId: schoolA.id, name: '5e A', level: '5e' } });

      const res = await api(adminToken).patch(`/classes/${klass.id}`).send({ promotesToId: cinquieme.id });
      expect(res.status).toBe(200);
      expect(res.body.promotesToId).toBe(cinquieme.id);
    });

    it('refuse qu’une classe se désigne elle-même', async () => {
      const res = await api(adminToken).patch(`/classes/${klass.id}`).send({ promotesToId: klass.id });
      expect(res.status).toBe(400);
    });

    it("refuse une classe supérieure d'une autre école", async () => {
      const foreign = await prisma.class.create({ data: { schoolId: schoolB.id, name: '5e A', level: '5e' } });

      const res = await api(adminToken).patch(`/classes/${klass.id}`).send({ promotesToId: foreign.id });
      expect(res.status).toBe(404);
    });

    it('détache promotesToId des classes qui la désignaient comme supérieure, plutôt que de refuser', async () => {
      const cinquieme = await prisma.class.create({ data: { schoolId: schoolA.id, name: '5e A', level: '5e' } });
      await api(adminToken).patch(`/classes/${klass.id}`).send({ promotesToId: cinquieme.id });
      await api(adminToken).delete(`/classes/${cinquieme.id}`);

      const res = await api(adminToken).delete(
        `/classes/${cinquieme.id}?permanent=true&confirm_label=5e A`,
      );
      expect(res.status).toBe(204);
      expect(await prisma.class.count({ where: { id: cinquieme.id } })).toBe(0);

      const source = await prisma.class.findUniqueOrThrow({ where: { id: klass.id } });
      expect(source.promotesToId).toBeNull();
    });
  });
});

describe('copie des coefficients depuis une classe du même niveau', () => {
  it('reprend les coefficients de la classe modèle', async () => {
    await prisma.subjectCoefficient.create({
      data: { subjectId: maths.id, classId: klass.id, coefficient: 5 },
    });

    const created = await api(adminToken)
      .post('/classes')
      .send({ name: '6e B', level: '6e', copyCoefficientsFromClassId: klass.id });

    expect(created.status).toBe(201);
    const copied = await prisma.subjectCoefficient.findMany({ where: { classId: created.body.id } });
    expect(copied).toHaveLength(1);
    expect(Number(copied[0]!.coefficient)).toBe(5);
  });

  it("refuse une classe modèle d'une autre école et ne crée rien", async () => {
    const foreign = await prisma.class.create({
      data: { schoolId: schoolB.id, name: '6e B', level: '6e' },
    });

    const res = await api(adminToken)
      .post('/classes')
      .send({ name: '6e B', level: '6e', copyCoefficientsFromClassId: foreign.id });

    expect(res.status).toBe(404);
    expect(await prisma.class.count({ where: { schoolId: schoolA.id } })).toBe(1);
  });
});

describe('GET /classes/:id — classement et statistiques', () => {
  it('classe les élèves par moyenne décroissante', async () => {
    const ana = await addStudent('Ana', 'Alpha');
    const ben = await addStudent('Ben', 'Beta');
    const cid = await addStudent('Cid', 'Gamma');
    await addGrade(ana.id, 12);
    await addGrade(ben.id, 18);
    await addGrade(cid.id, 15);

    const res = await api(adminToken).get(`/classes/${klass.id}?term_id=${term.id}`);
    expect(res.status).toBe(200);

    expect(res.body.students.map((s: { firstName: string }) => s.firstName)).toEqual([
      'Ben',
      'Cid',
      'Ana',
    ]);
    expect(res.body.students.map((s: { rang: number }) => s.rang)).toEqual([1, 2, 3]);
    expect(res.body.stats).toMatchObject({
      effectif: 3,
      evalues: 3,
      average: 15,
      meilleure: 18,
      plusFaible: 12,
    });
  });

  it('place les élèves sans note en fin de classement, sans rang', async () => {
    const ana = await addStudent('Ana', 'Alpha');
    await addStudent('Zoe', 'Zeta'); // aucune note
    await addGrade(ana.id, 12);

    const res = await api(adminToken).get(`/classes/${klass.id}?term_id=${term.id}`);

    const [first, second] = res.body.students;
    expect(first.firstName).toBe('Ana');
    expect(first.rang).toBe(1);
    // Un élève non évalué n'est pas dernier de la classe : il n'a pas de rang.
    expect(second.firstName).toBe('Zoe');
    expect(second.average).toBeNull();
    expect(second.rang).toBeNull();

    // Et il ne tire pas la moyenne de classe vers le bas.
    expect(res.body.stats.average).toBe(12);
    expect(res.body.stats.evalues).toBe(1);
  });

  it('exige une période', async () => {
    expect((await api(adminToken).get(`/classes/${klass.id}`)).status).toBe(400);
  });

  it('laisse un enseignant consulter le détail de SA classe', async () => {
    const prof = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await prisma.teacherAssignment.create({
      data: { schoolId: schoolA.id, teacherUserId: prof.id, classId: klass.id, subjectId: maths.id },
    });

    const res = await api(teacherToken).get(`/classes/${klass.id}?term_id=${term.id}`);
    expect(res.status).toBe(200);
  });

  it("refuse à un enseignant la classe d'un collègue", async () => {
    // Aucune affectation sur cette classe : le classement nominatif de tous
    // ses élèves ne le regarde pas.
    const res = await api(teacherToken).get(`/classes/${klass.id}?term_id=${term.id}`);
    expect(res.status).toBe(403);
  });

  it('REFUSE à un parent le classement nominatif de la classe', async () => {
    const parent = await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });
    const parentToken = signAccessToken({
      userId: parent.id,
      schoolId: schoolA.id,
      role: 'parent',
    });

    // La donnée la plus sensible du produit : noms, moyennes et rangs de tous
    // les élèves. Un parent consulte son enfant via /children/:id.
    expect((await api(parentToken).get(`/classes/${klass.id}?term_id=${term.id}`)).status).toBe(403);
    expect((await api(parentToken).get(`/classes/${klass.id}/bulletin?term_id=${term.id}`)).status).toBe(403);
    expect((await api(parentToken).get('/classes')).status).toBe(403);
  });

  it('expose le bulletin au même format', async () => {
    const ana = await addStudent('Ana', 'Alpha');
    await addGrade(ana.id, 14);

    const res = await api(adminToken).get(`/classes/${klass.id}/bulletin?term_id=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.students[0].subjects[0].subjectName).toBe('Maths');
    expect(res.body.students[0].subjects[0].average).toBe(14);
  });
});

describe('isolation par école', () => {
  it("renvoie 404 sur la classe d'une autre école", async () => {
    const foreign = await prisma.class.create({
      data: { schoolId: schoolB.id, name: '6e B', level: '6e' },
    });

    expect((await api(adminToken).get(`/classes/${foreign.id}?term_id=${term.id}`)).status).toBe(404);
    expect((await api(adminToken).patch(`/classes/${foreign.id}`).send({ name: 'Vole' })).status).toBe(404);
    expect((await api(adminToken).delete(`/classes/${foreign.id}`)).status).toBe(404);
  });

  it("refuse une période d'une autre école", async () => {
    const foreignTerm = await prisma.term.create({
      data: { schoolId: schoolB.id, label: 'T1 B' },
    });
    const res = await api(adminToken).get(`/classes/${klass.id}?term_id=${foreignTerm.id}`);
    expect(res.status).toBe(404);
  });
});

describe('archivage et suppression', () => {
  it('archive par défaut', async () => {
    expect((await api(adminToken).delete(`/classes/${klass.id}`)).status).toBe(204);
    expect((await api(adminToken).get('/classes')).body).toHaveLength(0);
    expect((await api(adminToken).get('/classes?include_archived=true')).body).toHaveLength(1);

    expect((await api(adminToken).post(`/classes/${klass.id}/restore`)).status).toBe(200);
    expect((await api(adminToken).get('/classes')).body).toHaveLength(1);
  });

  it('refuse la suppression définitive tant que la classe n’est pas archivée', async () => {
    const res = await api(adminToken).delete(`/classes/${klass.id}?permanent=true&confirm_label=6e A`);
    expect(res.status).toBe(409);
    expect(await prisma.class.count({ where: { id: klass.id } })).toBe(1);
  });

  it('refuse la suppression définitive si la confirmation ne correspond pas au nom', async () => {
    await api(adminToken).delete(`/classes/${klass.id}`);

    const res = await api(adminToken).delete(`/classes/${klass.id}?permanent=true&confirm_label=Mauvais nom`);
    expect(res.status).toBe(400);
    expect(await prisma.class.count({ where: { id: klass.id } })).toBe(1);
  });

  it('supprime définitivement une classe archivée et vide, avec le nom exact', async () => {
    await api(adminToken).delete(`/classes/${klass.id}`);

    const res = await api(adminToken).delete(`/classes/${klass.id}?permanent=true&confirm_label=6e A`);
    expect(res.status).toBe(204);
    expect(await prisma.class.count({ where: { schoolId: schoolA.id } })).toBe(0);
  });

  it('emporte en cascade les élèves de la classe, avec leurs notes, présences et liens parents', async () => {
    const ana = await addStudent('Ana', 'Alpha');
    await addGrade(ana.id, 14);
    const parent = await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });
    await prisma.studentParent.create({ data: { schoolId: schoolA.id, studentId: ana.id, parentUserId: parent.id } });
    await prisma.attendance.create({
      data: { schoolId: schoolA.id, studentId: ana.id, classId: klass.id, date: new Date(), status: 'present' },
    });

    await api(adminToken).delete(`/classes/${klass.id}`);
    const res = await api(adminToken).delete(`/classes/${klass.id}?permanent=true&confirm_label=6e A`);

    expect(res.status).toBe(204);
    expect(await prisma.student.count({ where: { id: ana.id } })).toBe(0);
    expect(await prisma.grade.count()).toBe(0);
    expect(await prisma.attendance.count()).toBe(0);
    expect(await prisma.studentParent.count()).toBe(0);
    // Le compte parent lui-même survit : seul le lien vers l'élève disparaît.
    expect(await prisma.user.count({ where: { id: parent.id } })).toBe(1);
  });

  it('emporte en cascade les évaluations, les affectations et les coefficients, même sans élève', async () => {
    const teacher = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await prisma.teacherAssignment.create({
      data: { schoolId: schoolA.id, teacherUserId: teacher.id, classId: klass.id, subjectId: maths.id },
    });
    await prisma.subjectCoefficient.create({
      data: { subjectId: maths.id, classId: klass.id, coefficient: 3 },
    });
    const evaluation = await prisma.evaluation.create({
      data: {
        schoolId: schoolA.id, classId: klass.id, subjectId: maths.id,
        gradeTypeId: compoId, termId: term.id, label: 'Composition',
      },
    });

    await api(adminToken).delete(`/classes/${klass.id}`);
    const res = await api(adminToken).delete(`/classes/${klass.id}?permanent=true&confirm_label=6e A`);

    expect(res.status).toBe(204);
    expect(await prisma.evaluation.count({ where: { id: evaluation.id } })).toBe(0);
    expect(await prisma.teacherAssignment.count()).toBe(0);
    expect(await prisma.subjectCoefficient.count()).toBe(0);
  });
});
