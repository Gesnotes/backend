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
    await seedGrade({
      schoolId: school.id,
      studentId: student.id,
      subjectId: maths.id,
      gradeTypeId: interro.id,
      termId: term.id,
      value: values.interro,
    });
    await seedGrade({
      schoolId: school.id,
      studentId: student.id,
      subjectId: maths.id,
      gradeTypeId: compo.id,
      termId: term.id,
      value: values.compo,
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

/** Récupère le corps binaire d'un export, en tant qu'admin. */
async function pdfBody(path: string): Promise<Buffer> {
  const res = await get(tokenAdmin, path)
    .buffer()
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  expect(res.status).toBe(200);
  return res.body as Buffer;
}

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
  it('les moyennes imprimées sont celles de GET /classes/:id', async () => {
    const json = await get(tokenAdmin, `/classes/${classe.id}?term_id=${term.id}`);

    // (12 + 3×16) / 4 = 15 pour Ana ; (10 + 3×10) / 4 = 10 pour Ben.
    const anaJson = json.body.students.find((s: { firstName: string }) => s.firstName === 'Ana');
    expect(anaJson.average).toBe(15);
    expect(json.body.stats.average).toBe(12.5);

    // Le PDF doit porter les MÊMES chiffres : sans cette vérification, un
    // second chemin de calcul pourrait diverger sans que rien ne le signale.
    const texte = pdfTextOf(await pdfBody(`/classes/${classe.id}/bulletin/export?term_id=${term.id}`));

    expect(texte).toContain('ALPHAAna');
    expect(texte).toContain('15,00');
    expect(texte).toContain('BETABen');
    expect(texte).toContain('10,00');
    expect(texte).toContain('Moyennedelaclasse:12,50');
  });

  it('imprime le détail par catégorie et le coefficient — la promesse d\'auditabilité', async () => {
    const texte = pdfTextOf(await pdfBody(`/classes/${classe.id}/bulletin/export?term_id=${term.id}`));

    // Un parent doit pouvoir refaire le calcul : (12 + 3×16) / 4 = 15.
    expect(texte).toContain('Interrogation×1:12,00');
    expect(texte).toContain('Composition×3:16,00');
    expect(texte).toContain('Mathématiques');
    expect(texte).toContain('Collège Sainte-Marie'.replace(/\s+/g, ''));
  });

  it('imprime « — » et jamais « 0 » pour un élève sans note', async () => {
    const vide = await prisma.class.create({
      data: { schoolId: school.id, name: '3e A', level: '3e' },
    });
    await prisma.student.create({
      data: { schoolId: school.id, classId: vide.id, firstName: 'Zoe', lastName: 'Zeta' },
    });

    const texte = pdfTextOf(await pdfBody(`/classes/${vide.id}/bulletin/export?term_id=${term.id}`));

    expect(texte).toContain('ZETAZoe');
    expect(texte).toContain('—');
    expect(texte).not.toContain('0,00');
    expect(texte).toContain("nevautpaszéro");
  });

  it('ne fait pas déborder le détail sur la ligne suivante', async () => {
    // Trois catégories dépassent la largeur de colonne et passent sur deux
    // lignes : la hauteur de ligne doit être mesurée, pas figée.
    const francais = await prisma.subject.create({
      data: { schoolId: school.id, name: 'Français', coefficient: 2 },
    });
    const compo = await prisma.gradeType.findFirstOrThrow({
      where: { schoolId: school.id, code: 'composition' },
    });
    await seedGrade({
      schoolId: school.id,
      studentId: ana.id,
      subjectId: francais.id,
      gradeTypeId: compo.id,
      termId: term.id,
      value: 11,
    });

    const texte = pdfTextOf(await pdfBody(`/classes/${classe.id}/bulletin/export?term_id=${term.id}`));

    // Les deux matières restent lisibles et distinctes.
    expect(texte).toContain('Mathématiques');
    expect(texte).toContain('Français');
    expect(texte).toContain('11,00');
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
