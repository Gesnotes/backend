import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase } from './helpers';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let school: { id: number };
let tokenParentA: string;
let tokenParentB: string;
let tokenProf: string;
let tokenAutreProf: string;
let tokenAdmin: string;
let classe: { id: number };
let maths: { id: number };
let term: { id: number };
let compoId: number;
let ana: { id: number };
let ben: { id: number };
let noteAna: { id: number };

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');

  const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  const parentA = await createUser({ schoolId: school.id, email: 'pa@a.test', role: 'parent' });
  const parentB = await createUser({ schoolId: school.id, email: 'pb@a.test', role: 'parent' });
  const prof = await createUser({ schoolId: school.id, email: 'prof@a.test', role: 'teacher' });
  const autreProf = await createUser({ schoolId: school.id, email: 'autre@a.test', role: 'teacher' });

  tokenAdmin = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
  tokenParentA = signAccessToken({ userId: parentA.id, schoolId: school.id, role: 'parent' });
  tokenParentB = signAccessToken({ userId: parentB.id, schoolId: school.id, role: 'parent' });
  tokenProf = signAccessToken({ userId: prof.id, schoolId: school.id, role: 'teacher' });
  tokenAutreProf = signAccessToken({ userId: autreProf.id, schoolId: school.id, role: 'teacher' });

  classe = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  const autreClasse = await prisma.class.create({
    data: { schoolId: school.id, name: '5e A', level: '5e' },
  });
  maths = await prisma.subject.create({
    data: { schoolId: school.id, name: 'Maths', coefficient: 4 },
  });
  term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });
  const compo = await prisma.gradeType.create({
    data: { schoolId: school.id, code: 'composition', label: 'Composition', weight: 3 },
  });
  compoId = compo.id;

  await prisma.teacherAssignment.create({
    data: { teacherUserId: prof.id, classId: classe.id, subjectId: maths.id },
  });
  await prisma.teacherAssignment.create({
    data: { teacherUserId: autreProf.id, classId: autreClasse.id, subjectId: maths.id },
  });

  ana = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ana', lastName: 'Alpha' },
  });
  ben = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ben', lastName: 'Beta' },
  });

  await prisma.studentParent.create({ data: { studentId: ana.id, parentUserId: parentA.id } });
  await prisma.studentParent.create({ data: { studentId: ben.id, parentUserId: parentB.id } });

  noteAna = await prisma.grade.create({
    data: {
      schoolId: school.id,
      studentId: ana.id,
      subjectId: maths.id,
      gradeTypeId: compoId,
      termId: term.id,
      teacherUserId: prof.id,
      value: 15,
      comment: 'Bon travail',
    },
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const get = (token: string, path: string) =>
  request(app).get(path).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`);

/**
 * Garde-fou symétrique de celui des enseignants : un parent ne voit que ses
 * propres enfants. Le refus est un 404 et non un 403 — répondre « interdit »
 * confirmerait l'existence de l'élève et permettrait de reconstituer les
 * effectifs en énumérant les identifiants.
 */
describe('cloisonnement entre parents', () => {
  it("le parent A ne voit pas l'enfant du parent B — 404, pas 403", async () => {
    const res = await get(tokenParentA, `/children/${ben.id}?term_id=${term.id}`);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("le parent A ne lit pas les notes de l'enfant du parent B", async () => {
    const res = await get(tokenParentA, `/children/${ben.id}/grades`);
    expect(res.status).toBe(404);
  });

  it("le parent B ne lit pas le détail d'une note de l'enfant du parent A", async () => {
    const res = await get(tokenParentB, `/grades/${noteAna.id}`);
    expect(res.status).toBe(404);
  });

  it('ne liste que mes propres enfants', async () => {
    const res = await get(tokenParentA, '/parents/me/children');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].firstName).toBe('Ana');
  });

  it("un parent d'une autre école ne voit rien", async () => {
    const autre = await createSchool('ecole-b');
    const parentAutre = await createUser({ schoolId: autre.id, email: 'p@b.test', role: 'parent' });
    const token = signAccessToken({ userId: parentAutre.id, schoolId: autre.id, role: 'parent' });

    const res = await request(app)
      .get(`/children/${ana.id}?term_id=${term.id}`)
      .set('X-School-Subdomain', 'ecole-a')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403); // sous-domaine incohérent avec le token
  });
});

describe('GET /parents/me/children', () => {
  it('renvoie la classe et la moyenne sur la période', async () => {
    const res = await get(tokenParentA, `/parents/me/children?term_id=${term.id}`);
    expect(res.body[0].classe.name).toBe('6e A');
    expect(res.body[0].average).toBe(15);
  });

  it('ne calcule pas de moyenne sans période', async () => {
    const res = await get(tokenParentA, '/parents/me/children');
    expect(res.body[0].average).toBeNull();
  });

  it('exclut un enfant archivé', async () => {
    await prisma.student.update({ where: { id: ana.id }, data: { archivedAt: new Date() } });
    expect((await get(tokenParentA, '/parents/me/children')).body).toHaveLength(0);
  });

  it('est refusée à un enseignant', async () => {
    expect((await get(tokenProf, '/parents/me/children')).status).toBe(403);
  });
});

describe('GET /children/:id', () => {
  it('renvoie la moyenne générale et le détail par matière', async () => {
    const res = await get(tokenParentA, `/children/${ana.id}?term_id=${term.id}`);

    expect(res.status).toBe(200);
    expect(res.body.average).toBe(15);
    expect(res.body.subjects[0].subjectName).toBe('Maths');
    expect(res.body.subjects[0].coefficient).toBe(4);
    expect(res.body.subjects[0].categories[0].label).toBe('Composition');
    expect(res.body.termLabel).toBe('Trimestre 1');
  });

  it('exige une période', async () => {
    expect((await get(tokenParentA, `/children/${ana.id}`)).status).toBe(400);
  });

  it('reste accessible au professeur de la classe et à l\'admin', async () => {
    expect((await get(tokenProf, `/children/${ana.id}?term_id=${term.id}`)).status).toBe(200);
    expect((await get(tokenAdmin, `/children/${ana.id}?term_id=${term.id}`)).status).toBe(200);
  });

  it("est refusée au professeur d'une autre classe", async () => {
    const res = await get(tokenAutreProf, `/children/${ana.id}?term_id=${term.id}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /children/:id/grades', () => {
  it("renvoie l'historique avec matière, période, type et professeur", async () => {
    const res = await get(tokenParentA, `/children/${ana.id}/grades`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      value: 15,
      maxValue: 20,
      comment: 'Bon travail',
    });
    expect(res.body[0].matiere.name).toBe('Maths');
    expect(res.body[0].periode.label).toBe('Trimestre 1');
    expect(res.body[0].type.label).toBe('Composition');
    expect(res.body[0].professeur.id).toBeTruthy();
  });

  it("ne divulgue pas l'email du professeur", async () => {
    const res = await get(tokenParentA, `/children/${ana.id}/grades`);
    expect(JSON.stringify(res.body)).not.toContain('prof@a.test');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('filtre par période', async () => {
    const autre = await prisma.term.create({ data: { schoolId: school.id, label: 'T2' } });

    expect((await get(tokenParentA, `/children/${ana.id}/grades?term_id=${term.id}`)).body).toHaveLength(1);
    expect((await get(tokenParentA, `/children/${ana.id}/grades?term_id=${autre.id}`)).body).toHaveLength(0);
  });

  it('filtre par matière', async () => {
    const autre = await prisma.subject.create({ data: { schoolId: school.id, name: 'Français' } });
    expect((await get(tokenParentA, `/children/${ana.id}/grades?subject_id=${autre.id}`)).body).toHaveLength(0);
  });
});

describe('GET /grades/:id', () => {
  it('est lisible par le parent de l\'élève', async () => {
    const res = await get(tokenParentA, `/grades/${noteAna.id}`);
    expect(res.status).toBe(200);
    expect(res.body.comment).toBe('Bon travail');
    expect(res.body.professeur.id).toBeTruthy();
  });

  it('est lisible par le professeur de la classe', async () => {
    expect((await get(tokenProf, `/grades/${noteAna.id}`)).status).toBe(200);
  });

  it("est refusée au professeur d'une autre classe", async () => {
    expect((await get(tokenAutreProf, `/grades/${noteAna.id}`)).status).toBe(404);
  });

  it('renvoie 404 sur une note inexistante', async () => {
    expect((await get(tokenParentA, '/grades/999999')).status).toBe(404);
  });

  it('ne casse pas la saisie enseignante montée sur le même préfixe', async () => {
    // GET /grades/:id est ouvert au parent, mais POST/PATCH/DELETE /grades
    // restent réservés aux enseignants.
    const res = await request(app)
      .post('/grades')
      .set('X-School-Subdomain', 'ecole-a')
      .set('Authorization', `Bearer ${tokenParentA}`)
      .send({
        studentId: ana.id,
        subjectId: maths.id,
        gradeTypeId: compoId,
        termId: term.id,
        value: 20,
      });
    expect(res.status).toBe(403);
  });
});
