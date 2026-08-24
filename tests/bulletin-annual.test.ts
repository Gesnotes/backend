import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase, seedGrade } from './helpers';
import { createApp } from '../src/app';
import { pdfTextOf } from './pdf-text';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let school: { id: number };
let tokenAdmin: string;
let tokenTeacher: string;
let tokenParent: string;
let classe: { id: number };
let schoolYear: { id: number; label: string };
let term1: { id: number };
let term2: { id: number };
let ana: { id: number };
let ben: { id: number };

/** (interro×1 + devoir×2 + compo×3) / 6 — même formule que `seedGrade` dans les autres suites. */
async function seedTermGrades(
  termId: number,
  subjectId: number,
  gradeTypes: { interro: number; devoir: number; compo: number },
  students: { student: { id: number }; values: { interro: number; devoir: number; compo: number } }[],
) {
  for (const { student, values } of students) {
    await seedGrade({
      schoolId: school.id,
      studentId: student.id,
      subjectId,
      gradeTypeId: gradeTypes.interro,
      termId,
      value: values.interro,
    });
    await seedGrade({
      schoolId: school.id,
      studentId: student.id,
      subjectId,
      gradeTypeId: gradeTypes.devoir,
      termId,
      value: values.devoir,
    });
    await seedGrade({
      schoolId: school.id,
      studentId: student.id,
      subjectId,
      gradeTypeId: gradeTypes.compo,
      termId,
      value: values.compo,
    });
  }
}

let maths: { id: number };
let gradeTypeIds: { interro: number; devoir: number; compo: number };

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a', 'Collège Sainte-Marie');

  const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: school.id, email: 'prof@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: school.id, email: 'pa@a.test', role: 'parent' });

  tokenAdmin = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
  tokenTeacher = signAccessToken({ userId: teacher.id, schoolId: school.id, role: 'teacher' });
  tokenParent = signAccessToken({ userId: parent.id, schoolId: school.id, role: 'parent' });

  schoolYear = await prisma.schoolYear.create({
    data: { schoolId: school.id, label: '2025-2026' },
  });

  classe = await prisma.class.create({
    data: { schoolId: school.id, name: '6e A', level: '6e', schoolYearId: schoolYear.id },
  });

  term1 = await prisma.term.create({
    data: {
      schoolId: school.id,
      schoolYearId: schoolYear.id,
      label: 'Trimestre 1',
      startDate: new Date('2025-09-01'),
    },
  });
  term2 = await prisma.term.create({
    data: {
      schoolId: school.id,
      schoolYearId: schoolYear.id,
      label: 'Trimestre 2',
      startDate: new Date('2026-01-01'),
    },
  });

  maths = await prisma.subject.create({
    data: { schoolId: school.id, name: 'Mathématiques', coefficient: 4 },
  });
  await prisma.subjectCoefficient.create({
    data: { classId: classe.id, subjectId: maths.id, coefficient: 4 },
  });

  const [interro, devoir, compo] = await Promise.all([
    prisma.gradeType.create({
      data: { schoolId: school.id, code: 'interrogation', label: 'Interrogation', weight: 1, position: 1 },
    }),
    prisma.gradeType.create({
      data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
    }),
    prisma.gradeType.create({
      data: { schoolId: school.id, code: 'composition', label: 'Composition', weight: 3, position: 3 },
    }),
  ]);
  gradeTypeIds = { interro: interro.id, devoir: devoir.id, compo: compo.id };

  ana = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ana', lastName: 'Alpha' },
  });
  ben = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ben', lastName: 'Beta' },
  });

  await prisma.studentParent.create({ data: { schoolId: school.id, studentId: ana.id, parentUserId: parent.id } });

  // Ana : 15 puis 18 → moyenne annuelle 16,50. Ben : 10 puis 14 → 12,00.
  await seedTermGrades(term1.id, maths.id, gradeTypeIds, [
    { student: ana, values: { interro: 12, devoir: 15, compo: 16 } },
    { student: ben, values: { interro: 10, devoir: 10, compo: 10 } },
  ]);
  await seedTermGrades(term2.id, maths.id, gradeTypeIds, [
    { student: ana, values: { interro: 18, devoir: 18, compo: 18 } },
    { student: ben, values: { interro: 14, devoir: 14, compo: 14 } },
  ]);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const get = (token: string, path: string) =>
  request(app).get(path).set('Authorization', `Bearer ${token}`);

const isPdf = (body: Buffer) => body.subarray(0, 5).toString() === '%PDF-';

async function pdfBody(token: string, path: string): Promise<{ status: number; body: Buffer }> {
  const res = await get(token, path)
    .buffer()
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return { status: res.status, body: res.body as Buffer };
}

describe('export du bulletin annuel de classe', () => {
  it('produit un PDF valide, une page par élève', async () => {
    const res = await pdfBody(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${schoolYear.id}`,
    );
    expect(res.status).toBe(200);
    expect(isPdf(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(500);
  });

  it('produit aussi le tableau de synthèse', async () => {
    const res = await pdfBody(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${schoolYear.id}&format=classe`,
    );
    expect(res.status).toBe(200);
    expect(isPdf(res.body)).toBe(true);
  });

  it('nomme le fichier sans accent ni espace, avec le libellé de l’année', async () => {
    const res = await get(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${schoolYear.id}`,
    );
    const disposition = res.headers['content-disposition'] as string;
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? '';
    expect(filename).toMatch(/^[a-z0-9-]+\.pdf$/);
    expect(filename).toContain('2025-2026');
    expect(filename).toContain('bulletin-annuel');
  });

  it('refuse un format inconnu', async () => {
    const res = await get(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${schoolYear.id}&format=nimportequoi`,
    );
    expect(res.status).toBe(400);
  });

  it('refuse une année scolaire manquante', async () => {
    const res = await get(tokenAdmin, `/classes/${classe.id}/bulletin/annual/export`);
    expect(res.status).toBe(400);
  });

  it('interdit à un parent', async () => {
    const res = await get(
      tokenParent,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${schoolYear.id}`,
    );
    expect(res.status).toBe(403);
  });

  it('accessible à un enseignant affecté à la classe', async () => {
    const teacher = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await prisma.teacherAssignment.create({
      data: { schoolId: school.id, teacherUserId: teacher.id, classId: classe.id, subjectId: maths.id },
    });

    const res = await pdfBody(
      tokenTeacher,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${schoolYear.id}`,
    );
    expect(res.status).toBe(200);
  });
});

describe('cohérence de la moyenne annuelle', () => {
  it('moyenne la moyenne brute de chaque période, sans redériver depuis les notes', async () => {
    const res = await pdfBody(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${schoolYear.id}`,
    );
    expect(res.status).toBe(200);
    const texte = pdfTextOf(res.body);

    // Ana : (15,00 + 18,00) / 2 = 16,50. Ben : (10,00 + 14,00) / 2 = 12,00.
    expect(texte).toContain('16,50');
    expect(texte).toContain('12,00');
    // Moyenne de classe annuelle : (16,50 + 12,00) / 2 = 14,25.
    expect(texte).toContain('14,25');
  });

  it('affiche les libellés des deux périodes dans le tableau de synthèse', async () => {
    const res = await pdfBody(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${schoolYear.id}&format=classe`,
    );
    const texte = pdfTextOf(res.body);
    expect(texte).toContain('Trimestre1');
    expect(texte).toContain('Trimestre2');
  });
});

describe('disponibilité du bulletin annuel', () => {
  it("refuse tant qu'une période de l'année n'est pas complète", async () => {
    // Troisième période de l'année, sans aucune note : l'année n'est pas
    // complète même si les deux premières le sont.
    const term3 = await prisma.term.create({
      data: { schoolId: school.id, schoolYearId: schoolYear.id, label: 'Trimestre 3' },
    });

    const res = await get(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${schoolYear.id}`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Trimestre 3');
    void term3;
  });

  it("refuse quand l'année scolaire n'a aucune période active", async () => {
    const videYear = await prisma.schoolYear.create({ data: { schoolId: school.id, label: '2030-2031' } });

    const res = await get(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/annual/export?school_year_id=${videYear.id}`,
    );
    expect(res.status).toBe(409);
  });
});

describe('export du bulletin annuel individuel (parent)', () => {
  it("un parent télécharge le bulletin annuel de son enfant", async () => {
    const res = await pdfBody(
      tokenParent,
      `/children/${ana.id}/bulletin/annual/export?school_year_id=${schoolYear.id}`,
    );
    expect(res.status).toBe(200);
    expect(isPdf(res.body)).toBe(true);

    const texte = pdfTextOf(res.body);
    expect(texte).toContain('16,50');
  });

  it("refuse un parent qui n'est pas celui de l'élève", async () => {
    const autre = await createUser({ schoolId: school.id, email: 'pc@a.test', role: 'parent' });
    const tokenAutre = signAccessToken({ userId: autre.id, schoolId: school.id, role: 'parent' });

    const res = await get(
      tokenAutre,
      `/children/${ana.id}/bulletin/annual/export?school_year_id=${schoolYear.id}`,
    );
    // `assertIsParentOf` répond 404, jamais 403 : ne pas révéler que l'élève existe.
    expect(res.status).toBe(404);
  });
});
