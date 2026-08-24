import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase, seedGrade } from './helpers';
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
    data: { schoolId: school.id, teacherUserId: prof.id, classId: classe.id, subjectId: maths.id },
  });
  await prisma.teacherAssignment.create({
    data: { schoolId: school.id, teacherUserId: autreProf.id, classId: autreClasse.id, subjectId: maths.id },
  });

  ana = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ana', lastName: 'Alpha' },
  });
  ben = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ben', lastName: 'Beta' },
  });

  await prisma.studentParent.create({ data: { schoolId: school.id, studentId: ana.id, parentUserId: parentA.id } });
  await prisma.studentParent.create({ data: { schoolId: school.id, studentId: ben.id, parentUserId: parentB.id } });

  noteAna = await seedGrade({
    schoolId: school.id,
    studentId: ana.id,
    subjectId: maths.id,
    gradeTypeId: compoId,
    termId: term.id,
    teacherUserId: prof.id,
    value: 15,
    comment: 'Bon travail',
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const get = (token: string, path: string) =>
  request(app).get(path).set('Authorization', `Bearer ${token}`);

describe('GET /children/:id/schedule', () => {
  it("un parent voit l'emploi du temps de la classe de son enfant", async () => {
    const assignment = await prisma.teacherAssignment.findFirstOrThrow({
      where: { schoolId: school.id, classId: classe.id, subjectId: maths.id },
    });
    await prisma.timetableSlot.create({
      data: {
        schoolId: school.id, teacherAssignmentId: assignment.id, dayOfWeek: 'lundi', startMinute: 480, endMinute: 540,
      },
    });

    const res = await get(tokenParentA, `/children/${ana.id}/schedule`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].subjectName).toBe('Maths');
    expect(res.body[0].startTime).toBe('08:00');
  });

  it("un parent d'un autre enfant est refusé (404)", async () => {
    const res = await get(tokenParentB, `/children/${ana.id}/schedule`);
    expect(res.status).toBe(404);
  });

  it('renvoie un tableau vide pour une classe en mode présence', async () => {
    const presenceClass = await prisma.class.create({
      data: { schoolId: school.id, name: 'Petite section', level: 'maternelle', mode: 'presence' },
    });
    const kid = await prisma.student.create({
      data: { schoolId: school.id, classId: presenceClass.id, firstName: 'Kim', lastName: 'Gamma' },
    });
    const parentAUser = await prisma.user.findFirstOrThrow({ where: { schoolId: school.id, email: 'pa@a.test' } });
    await prisma.studentParent.create({
      data: { schoolId: school.id, studentId: kid.id, parentUserId: parentAUser.id },
    });

    const res = await get(tokenParentA, `/children/${kid.id}/schedule`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

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
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404); // l'élève n'existe pas dans l'école du token
  });
});

describe('GET /parents/me/children', () => {
  it('renvoie la classe et la moyenne sur la période', async () => {
    // Devoir ajouté à la même valeur que la composition du beforeEach :
    // passe le seuil de publication (devoir + composition) sans déplacer la
    // moyenne attendue.
    const devoir = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 1 },
    });
    await seedGrade({
      schoolId: school.id,
      studentId: ana.id,
      subjectId: maths.id,
      gradeTypeId: devoir.id,
      termId: term.id,
      value: 15,
    });

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
    // Devoir ajouté à la même valeur que la composition du beforeEach :
    // passe le seuil de publication (devoir + composition) sans déplacer la
    // moyenne attendue, `position` garde Composition en tête du détail.
    const devoir = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 1 },
    });
    await seedGrade({
      schoolId: school.id,
      studentId: ana.id,
      subjectId: maths.id,
      gradeTypeId: devoir.id,
      termId: term.id,
      value: 15,
    });

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

  it("signale le bulletin prêt quand l'unique matière attendue de la classe est notée", async () => {
    // noteAna (beforeEach) note déjà Maths, seule matière rattachée à la classe.
    const res = await get(tokenParentA, `/children/${ana.id}?term_id=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.bulletinReady).toBe(true);
    expect(res.body.missingSubjects).toEqual([]);
  });

  it("signale le bulletin incomplet tant qu'une matière attendue de la classe n'est pas notée", async () => {
    const svt = await prisma.subject.create({ data: { schoolId: school.id, name: 'SVT' } });
    await prisma.subjectCoefficient.create({
      data: { classId: classe.id, subjectId: svt.id, coefficient: 1 },
    });

    const res = await get(tokenParentA, `/children/${ana.id}?term_id=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.bulletinReady).toBe(false);
    expect(res.body.missingSubjects).toEqual(['SVT']);
  });

  it("calcule la moyenne annuelle quand la période appartient à une année scolaire", async () => {
    const schoolYear = await prisma.schoolYear.create({
      data: { schoolId: school.id, label: '2025-2026' },
    });
    await prisma.term.update({ where: { id: term.id }, data: { schoolYearId: schoolYear.id } });
    const term2 = await prisma.term.create({
      data: { schoolId: school.id, label: 'Trimestre 2', schoolYearId: schoolYear.id },
    });
    // noteAna (composition, 15) + un devoir à 15 (beforeEach) passent le
    // trimestre 1 à 15 ; le trimestre 2 est noté à 19.
    const devoir = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 1 },
    });
    await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: devoir.id, termId: term.id, value: 15,
    });
    await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: compoId, termId: term2.id, value: 19,
    });
    await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: devoir.id, termId: term2.id, value: 19,
    });

    const res = await get(tokenParentA, `/children/${ana.id}?term_id=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.average).toBe(15);
    // (15 + 19) / 2 = 17
    expect(res.body.annualAverage).toBe(17);
  });

  it("ne calcule pas de moyenne annuelle si la période n'est rattachée à aucune année scolaire", async () => {
    const res = await get(tokenParentA, `/children/${ana.id}?term_id=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.annualAverage).toBeNull();
  });

  it('renvoie le rang de l\'enfant dans sa classe, sans exposer les autres élèves', async () => {
    // Devoir ajouté à la même valeur que la composition du beforeEach :
    // passe le seuil de publication (devoir + composition). Ben n'a aucune
    // note ce terme-là : exclu du classement.
    const devoir = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 1 },
    });
    await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: devoir.id, termId: term.id, value: 15,
    });

    const res = await get(tokenParentA, `/children/${ana.id}?term_id=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.rank).toEqual({ position: 1, total: 1 });
    expect(JSON.stringify(res.body)).not.toContain('Beta');
  });

  it("renvoie la tendance par période de l'année scolaire", async () => {
    const schoolYear = await prisma.schoolYear.create({
      data: { schoolId: school.id, label: '2025-2026' },
    });
    await prisma.term.update({ where: { id: term.id }, data: { schoolYearId: schoolYear.id } });
    await prisma.term.create({
      data: { schoolId: school.id, label: 'Trimestre 2', schoolYearId: schoolYear.id },
    });
    // noteAna (composition à 15, beforeEach) est la seule note de T1 pour Ana ;
    // devoir manquant : pas de moyenne matière publiée sur ce seul terme.
    const devoir = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 1 },
    });
    await seedGrade({
      schoolId: school.id, studentId: ana.id, subjectId: maths.id, gradeTypeId: devoir.id, termId: term.id, value: 15,
    });

    const res = await get(tokenParentA, `/children/${ana.id}?term_id=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.termTrend).toEqual([
      { termId: term.id, termLabel: 'Trimestre 1', average: 15 },
      { termId: expect.any(Number), termLabel: 'Trimestre 2', average: null },
    ]);
  });

  it("renvoie une tendance vide si la période n'est rattachée à aucune année scolaire", async () => {
    const res = await get(tokenParentA, `/children/${ana.id}?term_id=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.termTrend).toEqual([]);
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
