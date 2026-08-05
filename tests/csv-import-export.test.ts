import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase, seedGrade } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

/**
 * Import et export tableur.
 *
 * Ce sont les deux fonctions par lesquelles un secrétariat entre dans l'outil :
 * une liste d'élèves qu'on ne peut pas importer, ce sont 600 saisies à la main.
 */
const app = createApp();

let school: { id: number };
let tokenAdmin: string;
let tokenTeacher: string;
let sixieme: { id: number };
let cinquieme: { id: number };
let term: { id: number };

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');

  const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  const teacher = await createUser({ schoolId: school.id, email: 'prof@a.test', role: 'teacher' });

  tokenAdmin = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
  tokenTeacher = signAccessToken({ userId: teacher.id, schoolId: school.id, role: 'teacher' });

  sixieme = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  cinquieme = await prisma.class.create({ data: { schoolId: school.id, name: '5e B', level: '5e' } });
  term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) =>
    request(app).get(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
  post: (p: string) =>
    request(app).post(p).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`),
});

const importCsv = (csv: string, dryRun = true) =>
  api(tokenAdmin).post('/students/import').send({ csv, dryRun });

describe('POST /students/import', () => {
  const liste = [
    'Nom;Prénom;Classe;Date de naissance',
    'SAGBO;Adjovi;6e A;12/03/2012',
    'ZETA;Zoé;5e B;2011-09-01',
  ].join('\n');

  it('analyse sans rien écrire tant que dryRun n’est pas levé', async () => {
    const res = await importCsv(liste);

    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ create: 2, duplicate: 0, error: 0 });
    expect(res.body.dryRun).toBe(true);
    expect(await prisma.student.count()).toBe(0);
  });

  it('inscrit les élèves une fois l’import confirmé', async () => {
    await importCsv(liste);
    const res = await importCsv(liste, false);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);

    const students = await prisma.student.findMany({ orderBy: { lastName: 'asc' } });
    expect(students).toHaveLength(2);
    expect(students[0]).toMatchObject({ lastName: 'SAGBO', firstName: 'Adjovi', classId: sixieme.id });
    expect(students[0]?.birthDate?.toISOString().slice(0, 10)).toBe('2012-03-12');
    expect(students[1]).toMatchObject({ classId: cinquieme.id });
  });

  /**
   * Une classe inconnue est une faute de frappe neuf fois sur dix ; en créer
   * une scinderait l'effectif d'un niveau sans que personne ne le voie.
   */
  it('refuse une classe inconnue sans la créer', async () => {
    const res = await importCsv('Nom;Prénom;Classe\nSAGBO;Adjovi;6e Z', false);

    expect(res.body.counts).toMatchObject({ create: 0, error: 1 });
    expect(res.body.rows[0].reason).toMatch(/n'existe pas/i);
    expect(await prisma.class.count()).toBe(2);
    expect(await prisma.student.count()).toBe(0);
  });

  it('reconnaît la classe malgré la casse et les accents', async () => {
    const res = await importCsv('Nom;Prénom;Classe\nSAGBO;Adjovi;  6E  a  ');
    expect(res.body.counts.create).toBe(1);
  });

  it('signale les doublons déjà inscrits, sans les recréer', async () => {
    await prisma.student.create({
      data: { schoolId: school.id, classId: sixieme.id, firstName: 'Adjovi', lastName: 'SAGBO' },
    });

    const res = await importCsv(liste, false);

    expect(res.body.counts).toMatchObject({ create: 1, duplicate: 1 });
    expect(await prisma.student.count()).toBe(2);
  });

  it('traite un doublon interne au fichier comme un doublon', async () => {
    const res = await importCsv(
      'Nom;Prénom;Classe\nSAGBO;Adjovi;6e A\nSAGBO;Adjovi;6e A',
    );
    expect(res.body.counts).toMatchObject({ create: 1, duplicate: 1 });
  });

  /** L'utilisateur doit voir toutes ses fautes d'un coup, pas une par tentative. */
  it('rend toutes les lignes fautives en un seul rapport', async () => {
    const res = await importCsv(
      ['Nom;Prénom;Classe;Date de naissance',
       ';Adjovi;6e A;',
       'ZETA;Zoé;6e Z;',
       'MU;Max;6e A;31/02/2012',
       'OK;Bon;6e A;'].join('\n'),
    );

    expect(res.body.counts).toMatchObject({ create: 1, error: 3 });
    expect(res.body.rows.map((r: { line: number }) => r.line)).toEqual([2, 3, 4, 5]);
    expect(res.body.rows[2].reason).toMatch(/illisible/i);
  });

  it('accepte un fichier réenregistré depuis Excel (BOM, virgule, CRLF)', async () => {
    const res = await importCsv('﻿Nom,Prénom,Classe\r\nSAGBO,Adjovi,6e A\r\n\r\n');
    expect(res.body.counts).toMatchObject({ create: 1, error: 0 });
  });

  it('nomme les colonnes manquantes plutôt que de refuser en bloc', async () => {
    const res = await importCsv('Nom;Classe\nSAGBO;6e A');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Prénom/);
  });

  it('n’écrit rien si une seule ligne est fautive — tout ou rien', async () => {
    await importCsv('Nom;Prénom;Classe\nSAGBO;Adjovi;6e A\nZETA;Zoé;6e Z', false);

    // La ligne valide passe, la fautive est signalée : le rapport dit lesquelles.
    expect(await prisma.student.count()).toBe(1);
  });

  it('réserve l’import à l’administration', async () => {
    const res = await api(tokenTeacher).post('/students/import').send({ csv: liste });
    expect(res.status).toBe(403);
  });

  it('ne laisse pas importer dans la classe d’une autre école', async () => {
    const autre = await createSchool('ecole-b');
    await prisma.class.create({ data: { schoolId: autre.id, name: '3e Z', level: '3e' } });

    const res = await importCsv('Nom;Prénom;Classe\nSAGBO;Adjovi;3e Z');
    expect(res.body.counts.error).toBe(1);
  });
});

describe('GET /students/export/csv', () => {
  beforeEach(async () => {
    await prisma.student.createMany({
      data: [
        { schoolId: school.id, classId: sixieme.id, firstName: 'Adjovi', lastName: 'SAGBO' },
        { schoolId: school.id, classId: cinquieme.id, firstName: 'Zoé', lastName: 'ZETA' },
      ],
    });
  });

  it('rend un CSV lisible par Excel : BOM, point-virgule', async () => {
    const res = await api(tokenAdmin).get('/students/export/csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.startsWith('﻿')).toBe(true);
    expect(res.text).toContain('Nom;Prénom;Classe');
    expect(res.text).toContain('SAGBO;Adjovi;6e A');
  });

  it('exporte tout l’établissement, sans pagination', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      schoolId: school.id,
      classId: sixieme.id,
      firstName: `Prenom${i}`,
      lastName: `Nom${i}`,
    }));
    await prisma.student.createMany({ data: many });

    const res = await api(tokenAdmin).get('/students/export/csv');

    // 122 élèves + l'en-tête, et la liste paginée s'arrête à 100.
    expect(res.text.trim().split('\r\n')).toHaveLength(123);
  });

  it('filtre par classe', async () => {
    const res = await api(tokenAdmin).get(`/students/export/csv?class_id=${sixieme.id}`);

    expect(res.text).toContain('SAGBO');
    expect(res.text).not.toContain('ZETA');
  });

  /** Un enseignant n'a pas à disposer de l'annuaire des familles. */
  it('masque les coordonnées des parents à un enseignant', async () => {
    await prisma.teacherAssignment.create({
      data: {
        schoolId: school.id,
        teacherUserId: (await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } })).id,
        classId: sixieme.id,
        subjectId: (await prisma.subject.create({ data: { schoolId: school.id, name: 'Maths' } })).id,
      },
    });

    const res = await api(tokenTeacher).get('/students/export/csv');

    expect(res.text).not.toContain('Contacts parents');
    // Et il ne voit que sa classe.
    expect(res.text).not.toContain('ZETA');
  });
});

describe('GET /classes/:id/bulletin/csv', () => {
  beforeEach(async () => {
    const maths = await prisma.subject.create({
      data: { schoolId: school.id, name: 'Maths', coefficient: 4 },
    });
    const devoir = await prisma.gradeType.create({
      data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 1, position: 1 },
    });
    const ana = await prisma.student.create({
      data: { schoolId: school.id, classId: sixieme.id, firstName: 'Ana', lastName: 'ALPHA' },
    });
    await prisma.student.create({
      data: { schoolId: school.id, classId: sixieme.id, firstName: 'Zoé', lastName: 'ZETA' },
    });

    await seedGrade({
      schoolId: school.id,
      studentId: ana.id,
      subjectId: maths.id,
      gradeTypeId: devoir.id,
      termId: term.id,
      value: 13.5,
    });
  });

  it('rend les moyennes avec la virgule décimale, colonne par matière', async () => {
    const res = await api(tokenAdmin).get(`/classes/${sixieme.id}/bulletin/csv?term_id=${term.id}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Maths (coef. 4)');
    // 13,50 et non 13.50 : sinon Excel FR y voit du texte, non triable.
    expect(res.text).toContain('13,50');
    expect(res.text).not.toContain('13.50');
  });

  /** Un élève sans note n'est pas dernier de la classe : il n'a pas de rang. */
  it('classe les élèves notés et laisse les autres sans rang', async () => {
    const res = await api(tokenAdmin).get(`/classes/${sixieme.id}/bulletin/csv?term_id=${term.id}`);
    const lines = res.text.trim().split('\r\n');

    expect(lines[1]).toContain('ALPHA');
    expect(lines[1]?.endsWith(';1')).toBe(true);
    expect(lines[2]).toContain('ZETA');
    expect(lines[2]?.endsWith(';—')).toBe(true);
  });

  it('refuse un bulletin sans aucune note', async () => {
    const res = await api(tokenAdmin).get(
      `/classes/${cinquieme.id}/bulletin/csv?term_id=${term.id}`,
    );
    expect(res.status).toBe(409);
  });
});
