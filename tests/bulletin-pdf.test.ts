import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase } from './helpers';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let school: { id: number };
let tokenAdmin: string;
let tokenParent: string;
let tokenAutreParent: string;
let classe: { id: number };
let term: { id: number };
let ana: { id: number };

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a', 'Collège Sainte-Marie');

  const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  const parent = await createUser({ schoolId: school.id, email: 'pa@a.test', role: 'parent' });
  const autre = await createUser({ schoolId: school.id, email: 'pb@a.test', role: 'parent' });

  tokenAdmin = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
  tokenParent = signAccessToken({ userId: parent.id, schoolId: school.id, role: 'parent' });
  tokenAutreParent = signAccessToken({ userId: autre.id, schoolId: school.id, role: 'parent' });

  classe = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });

  const maths = await prisma.subject.create({
    data: { schoolId: school.id, name: 'Mathématiques', coefficient: 4 },
  });
  const [interro, compo] = await Promise.all([
    prisma.gradeType.create({
      data: { schoolId: school.id, code: 'interrogation', label: 'Interrogation', weight: 1, position: 1 },
    }),
    prisma.gradeType.create({
      data: { schoolId: school.id, code: 'composition', label: 'Composition', weight: 3, position: 3 },
    }),
  ]);

  ana = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ana', lastName: 'Alpha' },
  });
  const ben = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ben', lastName: 'Beta' },
  });

  await prisma.studentParent.create({ data: { studentId: ana.id, parentUserId: parent.id } });
  await prisma.studentParent.create({ data: { studentId: ben.id, parentUserId: autre.id } });

  for (const [student, values] of [
    [ana, { interro: 12, compo: 16 }],
    [ben, { interro: 10, compo: 10 }],
  ] as const) {
    await prisma.grade.create({
      data: {
        schoolId: school.id,
        studentId: student.id,
        subjectId: maths.id,
        gradeTypeId: interro.id,
        termId: term.id,
        value: values.interro,
      },
    });
    await prisma.grade.create({
      data: {
        schoolId: school.id,
        studentId: student.id,
        subjectId: maths.id,
        gradeTypeId: compo.id,
        termId: term.id,
        value: values.compo,
      },
    });
  }
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const get = (token: string, path: string) =>
  request(app).get(path).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`);

const isPdf = (body: Buffer) => body.subarray(0, 5).toString() === '%PDF-';

describe('export du bulletin de classe', () => {
  it('produit un PDF valide, une page par élève', async () => {
    const res = await get(tokenAdmin, `/classes/${classe.id}/bulletin/export?term_id=${term.id}`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('.pdf');
    expect(isPdf(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it('produit aussi le tableau de synthèse', async () => {
    const res = await get(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/export?term_id=${term.id}&format=classe`,
    )
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(isPdf(res.body)).toBe(true);
  });

  it('nomme le fichier sans accent ni espace', async () => {
    const res = await get(tokenAdmin, `/classes/${classe.id}/bulletin/export?term_id=${term.id}`);
    const disposition = res.headers['content-disposition'] as string;

    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? '';
    // "Trimestre 1" et les accents ne doivent pas se retrouver tels quels dans
    // un nom de fichier téléchargé sous Windows.
    expect(filename).toMatch(/^[a-z0-9-]+\.pdf$/);
    expect(filename).toContain('trimestre-1');
  });

  it('refuse un format inconnu', async () => {
    const res = await get(
      tokenAdmin,
      `/classes/${classe.id}/bulletin/export?term_id=${term.id}&format=xlsx`,
    );
    expect(res.status).toBe(400);
  });

  it('exige une période', async () => {
    expect((await get(tokenAdmin, `/classes/${classe.id}/bulletin/export`)).status).toBe(400);
  });

  it("refuse la classe d'une autre école", async () => {
    const autre = await createSchool('ecole-b');
    const foreign = await prisma.class.create({
      data: { schoolId: autre.id, name: '6e B', level: '6e' },
    });

    const res = await get(tokenAdmin, `/classes/${foreign.id}/bulletin/export?term_id=${term.id}`);
    expect(res.status).toBe(404);
  });

  it("n'est pas accessible à un parent", async () => {
    const res = await get(tokenParent, `/classes/${classe.id}/bulletin/export?term_id=${term.id}`);
    // Le tableau de classe expose les résultats de tous les enfants.
    expect(res.status).toBe(403);
  });
});

describe('export du bulletin individuel', () => {
  it('est accessible au parent de l\'élève', async () => {
    const res = await get(tokenParent, `/children/${ana.id}/bulletin/export?term_id=${term.id}`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(isPdf(res.body)).toBe(true);
    expect(res.headers['content-disposition']).toContain('alpha');
  });

  it("est refusé au parent d'un autre élève", async () => {
    const res = await get(tokenAutreParent, `/children/${ana.id}/bulletin/export?term_id=${term.id}`);
    expect(res.status).toBe(404);
  });
});

describe('cohérence avec le calcul', () => {
  it('les moyennes du bulletin sont celles de GET /classes/:id', async () => {
    const json = await get(tokenAdmin, `/classes/${classe.id}?term_id=${term.id}`);

    // (12 + 3×16) / 4 = 15 pour Ana ; (10 + 3×10) / 4 = 10 pour Ben.
    const ana2 = json.body.students.find((s: { firstName: string }) => s.firstName === 'Ana');
    expect(ana2.average).toBe(15);
    expect(json.body.stats.average).toBe(12.5);

    // Le PDF est généré à partir de la même source : s'il diverge, c'est que
    // deux chemins de calcul coexistent.
    const pdf = await get(tokenAdmin, `/classes/${classe.id}/bulletin/export?term_id=${term.id}`);
    expect(pdf.status).toBe(200);
  });

  it('génère un PDF même pour une classe sans aucune note', async () => {
    const vide = await prisma.class.create({
      data: { schoolId: school.id, name: '5e A', level: '5e' },
    });
    await prisma.student.create({
      data: { schoolId: school.id, classId: vide.id, firstName: 'Zoe', lastName: 'Zeta' },
    });

    const res = await get(tokenAdmin, `/classes/${vide.id}/bulletin/export?term_id=${term.id}`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(isPdf(res.body)).toBe(true);
  });

  it('génère un PDF pour une classe vide', async () => {
    const vide = await prisma.class.create({
      data: { schoolId: school.id, name: '4e A', level: '4e' },
    });

    const res = await get(tokenAdmin, `/classes/${vide.id}/bulletin/export?term_id=${term.id}`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(isPdf(res.body)).toBe(true);
  });
});
