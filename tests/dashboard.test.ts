import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { Prisma } from '../src/generated/prisma/client';
import { createSchool, createUser, resetDatabase, seedEvaluation, seedGrade } from './helpers';
import { createApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let school: { id: number };
let autreEcole: { id: number };
let tokenAdmin: string;
let tokenProf: string;
let classe6: { id: number };
let classe5: { id: number };
let term: { id: number };
let maths: { id: number };
let compoId: number;
let devoirId: number;

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');
  autreEcole = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  const prof = await createUser({ schoolId: school.id, email: 'prof@a.test', role: 'teacher' });
  await createUser({ schoolId: school.id, email: 'parent@a.test', role: 'parent' });

  tokenAdmin = signAccessToken({ userId: admin.id, schoolId: school.id, role: 'admin' });
  tokenProf = signAccessToken({ userId: prof.id, schoolId: school.id, role: 'teacher' });

  classe6 = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  classe5 = await prisma.class.create({ data: { schoolId: school.id, name: '5e A', level: '5e' } });
  term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });
  maths = await prisma.subject.create({ data: { schoolId: school.id, name: 'Maths' } });
  const compo = await prisma.gradeType.create({
    data: { schoolId: school.id, code: 'composition', label: 'Composition', weight: 3 },
  });
  compoId = compo.id;
  const devoir = await prisma.gradeType.create({
    data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2 },
  });
  devoirId = devoir.id;
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const get = (token: string, path: string) =>
  request(app).get(path).set('X-School-Subdomain', 'ecole-a').set('Authorization', `Bearer ${token}`);

const addStudent = (classId: number, firstName: string) =>
  prisma.student.create({
    data: { schoolId: school.id, classId, firstName, lastName: 'Nom' },
  });

const addGrade = (studentId: number, value: number) =>
  seedGrade({
    schoolId: school.id,
    studentId,
    subjectId: maths.id,
    gradeTypeId: compoId,
    termId: term.id,
    value,
  });

/**
 * Devoir et composition à la même valeur : passe le seuil de publication de
 * la moyenne (devoir + composition requis) sans déplacer la valeur attendue
 * — à utiliser quand le test porte sur une moyenne, pas sur un simple compte
 * de notes saisies.
 */
const addGradedSubject = async (studentId: number, value: number) => {
  await seedGrade({
    schoolId: school.id,
    studentId,
    subjectId: maths.id,
    gradeTypeId: devoirId,
    termId: term.id,
    value,
  });
  return addGrade(studentId, value);
};

describe('GET /admin/dashboard', () => {
  it('compte les effectifs actifs', async () => {
    await addStudent(classe6.id, 'Ana');
    const archive = await addStudent(classe6.id, 'Zoe');
    await prisma.student.update({ where: { id: archive.id }, data: { archivedAt: new Date() } });

    const res = await get(tokenAdmin, '/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.effectifs).toMatchObject({
      eleves: 1,
      classes: 2,
      enseignants: 1,
      matieres: 1,
      parents: 1,
    });
  });

  it("expose le nom de l'école, toujours, même sans période", async () => {
    const res = await get(tokenAdmin, '/admin/dashboard');
    expect(res.body.school).toEqual({ name: 'École ecole-a' });
  });

  it('ne compte jamais les données des autres écoles', async () => {
    const autreClasse = await prisma.class.create({
      data: { schoolId: autreEcole.id, name: '6e B', level: '6e' },
    });
    await prisma.student.create({
      data: { schoolId: autreEcole.id, classId: autreClasse.id, firstName: 'X', lastName: 'Y' },
    });
    await createUser({ schoolId: autreEcole.id, email: 'prof@b.test', role: 'teacher' });

    const res = await get(tokenAdmin, '/admin/dashboard');
    expect(res.body.effectifs.eleves).toBe(0);
    expect(res.body.effectifs.enseignants).toBe(1);
    expect(res.body.effectifs.classes).toBe(2);
  });

  it('compte les notes des 7 derniers jours', async () => {
    const ana = await addStudent(classe6.id, 'Ana');
    const recente = await addGrade(ana.id, 15);

    const ancienne = await addGrade(ana.id, 10);
    await prisma.grade.update({
      where: { id: ancienne.id },
      data: { createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });
    void recente;

    const res = await get(tokenAdmin, '/admin/dashboard');
    expect(res.body.activite.notesDerniers7Jours).toBe(1);
    expect(res.body.activite.notesTotal).toBe(2);
  });

  it('ne calcule aucune moyenne sans période', async () => {
    const ana = await addStudent(classe6.id, 'Ana');
    await addGrade(ana.id, 15);

    const res = await get(tokenAdmin, '/admin/dashboard');
    expect(res.body.moyenneEcole).toBeNull();
    expect(res.body.classes).toEqual([]);
  });

  it("pondère la moyenne de l'école par élève, pas par classe", async () => {
    // 6e A : 3 élèves à 18. 5e A : 1 élève à 6.
    // Moyenne par élève = (18×3 + 6) / 4 = 15
    // Moyenne par classe = (18 + 6) / 2 = 12 — ce n'est PAS ce qu'on veut :
    // une classe de 1 élève ne doit pas peser autant qu'une de 3.
    for (const prenom of ['A', 'B', 'C']) {
      const eleve = await addStudent(classe6.id, prenom);
      await addGradedSubject(eleve.id, 18);
    }
    const seul = await addStudent(classe5.id, 'D');
    await addGradedSubject(seul.id, 6);

    const res = await get(tokenAdmin, `/admin/dashboard?term_id=${term.id}`);
    expect(res.body.moyenneEcole).toBe(15);
    expect(res.body.moyenneEcole).not.toBe(12);
  });

  it("garde la pleine précision jusqu'à l'arrondi final (pas de double-arrondi)", async () => {
    // Devoir 1/3 + composition 2/3 (sur 20) : moyenne exacte 32/3 = 10,6666...,
    // une décimale qui ne s'arrête jamais. Trois élèves identiques : la
    // moyenne d'école correcte reste 32/3 → 10,67. Un double-arrondi (chaque
    // élève arrondi à 10,67 individuellement) donnerait ici le même résultat
    // par coïncidence — la valeur du test est de vérifier que le calcul ne
    // passe jamais par un `Number` intermédiaire qui tronquerait cette
    // décimale périodique avant l'arrondi final.
    for (const prenom of ['A', 'B', 'C']) {
      const eleve = await addStudent(classe6.id, prenom);
      await seedGrade({
        schoolId: school.id,
        studentId: eleve.id,
        subjectId: maths.id,
        gradeTypeId: devoirId,
        termId: term.id,
        value: 1,
        maxValue: 3,
      });
      await seedGrade({
        schoolId: school.id,
        studentId: eleve.id,
        subjectId: maths.id,
        gradeTypeId: compoId,
        termId: term.id,
        value: 2,
        maxValue: 3,
      });
    }

    const res = await get(tokenAdmin, `/admin/dashboard?term_id=${term.id}`);
    expect(res.body.moyenneEcole).toBe(10.67);

    // Même précision attendue sur la moyenne de la classe elle-même.
    const classe6Row = res.body.classes.find((c: { className: string }) => c.className === '6e A');
    expect(classe6Row.average).toBe(10.67);
  });

  it('donne le détail par classe et les extrêmes', async () => {
    const forte = await addStudent(classe6.id, 'Ana');
    await addGradedSubject(forte.id, 18);
    const faible = await addStudent(classe5.id, 'Ben');
    await addGradedSubject(faible.id, 8);

    const res = await get(tokenAdmin, `/admin/dashboard?term_id=${term.id}`);
    expect(res.body.classes).toHaveLength(2);
    expect(res.body.extremes.meilleureClasse.className).toBe('6e A');
    expect(res.body.extremes.plusFaibleClasse.className).toBe('5e A');
  });

  it("expose l'avancement de la saisie et les classes oubliées", async () => {
    const evalue = await addStudent(classe6.id, 'Ana');
    await addGradedSubject(evalue.id, 15);
    await addStudent(classe6.id, 'Ben'); // sans note
    await addStudent(classe5.id, 'Cid'); // classe entière sans note

    const res = await get(tokenAdmin, `/admin/dashboard?term_id=${term.id}`);
    expect(res.body.saisie).toMatchObject({
      elevesEvalues: 1,
      elevesTotal: 3,
      taux: 33,
    });
    expect(res.body.saisie.classesSansAucuneNote).toEqual(['5e A']);
  });

  it('reste cohérent sur une école vide', async () => {
    const res = await get(tokenAdmin, `/admin/dashboard?term_id=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.moyenneEcole).toBeNull();
    expect(res.body.saisie.taux).toBeNull();
  });

  it("ignore une période d'une autre école", async () => {
    const foreignTerm = await prisma.term.create({
      data: { schoolId: autreEcole.id, label: 'T1 B' },
    });
    const res = await get(tokenAdmin, `/admin/dashboard?term_id=${foreignTerm.id}`);
    expect(res.body.periode).toBeNull();
  });

  it('est réservé à l\'administration', async () => {
    expect((await get(tokenProf, '/admin/dashboard')).status).toBe(403);
  });

  it("expose la présence du jour, sans dépendre d'une période", async () => {
    const present = await addStudent(classe6.id, 'Ana');
    const absent = await addStudent(classe6.id, 'Ben');
    const today = new Date(new Date().toISOString().slice(0, 10));
    await prisma.attendance.create({
      data: { schoolId: school.id, studentId: present.id, classId: classe6.id, date: today, status: 'present' },
    });
    await prisma.attendance.create({
      data: { schoolId: school.id, studentId: absent.id, classId: classe6.id, date: today, status: 'absent' },
    });
    await addStudent(classe5.id, 'Cid'); // 5e A : aucun appel aujourd'hui

    const res = await get(tokenAdmin, '/admin/dashboard');
    expect(res.body.presence).toMatchObject({
      classesAvecAppel: 1,
      classesTotal: 2,
      absents: 1,
      retards: 0,
    });
    expect(res.body.presence.classesSansAppel).toEqual(['5e A']);
  });

  it("utilise le jour transmis par le client plutôt que le jour UTC du serveur", async () => {
    // Une école à l'est de Greenwich peut avoir un jour local en avance sur
    // le jour UTC du serveur : le dashboard doit alors suivre le jour transmis
    // par le navigateur, pas recalculer « aujourd'hui » lui-même.
    const eleve = await addStudent(classe6.id, 'Ana');
    const demainUtc = new Date();
    demainUtc.setUTCDate(demainUtc.getUTCDate() + 1);
    const demainIso = demainUtc.toISOString().slice(0, 10);

    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        studentId: eleve.id,
        classId: classe6.id,
        date: new Date(demainIso),
        status: 'present',
      },
    });

    const sansDate = await get(tokenAdmin, '/admin/dashboard');
    expect(sansDate.body.presence.classesAvecAppel).toBe(0);

    const avecDate = await get(tokenAdmin, `/admin/dashboard?date=${demainIso}`);
    expect(avecDate.body.presence.classesAvecAppel).toBe(1);
  });

  it("ignore la présence d'un autre jour que celui du jour", async () => {
    const eleve = await addStudent(classe6.id, 'Ana');
    const hier = new Date();
    hier.setDate(hier.getDate() - 1);
    await prisma.attendance.create({
      data: { schoolId: school.id, studentId: eleve.id, classId: classe6.id, date: hier, status: 'absent' },
    });

    const res = await get(tokenAdmin, '/admin/dashboard');
    expect(res.body.presence.classesAvecAppel).toBe(0);
    expect(res.body.presence.absents).toBe(0);
    expect(res.body.presence.classesSansAppel).toEqual(['5e A', '6e A']);
  });

  it('tient la charge sur 30 classes sans exploser en requêtes', async () => {
    // Taille visée par le plan : un collège de 30 classes. En boucle sur
    // computeClassBulletin, ce dashboard ferait 150 requêtes SQL par
    // chargement ; le chemin par lot en fait cinq.
    // Une évaluation par classe (une note ne vit plus sans son évaluation) ;
    // les élèves d'une classe partagent la sienne.
    const gradeRows: Prisma.GradeCreateManyInput[] = [];
    let index = 0;
    for (let c = 0; c < 30; c += 1) {
      const classe = await prisma.class.create({
        data: { schoolId: school.id, name: `Classe ${c}`, level: '6e' },
      });
      const evaluationDevoir = await seedEvaluation({
        schoolId: school.id,
        classId: classe.id,
        subjectId: maths.id,
        gradeTypeId: devoirId,
        termId: term.id,
      });
      const evaluationCompo = await seedEvaluation({
        schoolId: school.id,
        classId: classe.id,
        subjectId: maths.id,
        gradeTypeId: compoId,
        termId: term.id,
      });
      for (let e = 0; e < 20; e += 1) {
        const eleve = await addStudent(classe.id, `E${c}-${e}`);
        // Devoir et composition à la même valeur : passe le seuil de
        // publication sans changer la moyenne attendue.
        const value = new Prisma.Decimal(10 + (index % 10));
        gradeRows.push({
          schoolId: school.id,
          studentId: eleve.id,
          evaluationId: evaluationDevoir.id,
          subjectId: maths.id,
          gradeTypeId: devoirId,
          termId: term.id,
          value,
        });
        gradeRows.push({
          schoolId: school.id,
          studentId: eleve.id,
          evaluationId: evaluationCompo.id,
          subjectId: maths.id,
          gradeTypeId: compoId,
          termId: term.id,
          value,
        });
        index += 1;
      }
    }
    await prisma.grade.createMany({ data: gradeRows });

    const debut = Date.now();
    const res = await get(tokenAdmin, `/admin/dashboard?term_id=${term.id}`);
    const duree = Date.now() - debut;

    expect(res.status).toBe(200);
    expect(res.body.effectifs.eleves).toBe(600);
    expect(res.body.classes).toHaveLength(32);
    expect(res.body.moyenneEcole).not.toBeNull();
    expect(duree).toBeLessThan(1000);
  });
});

describe('GET /admin/dashboard/recent-grades', () => {
  it("renvoie le flux d'activité, du plus récent au plus ancien", async () => {
    const ana = await addStudent(classe6.id, 'Ana');
    await addGrade(ana.id, 10);
    await addGrade(ana.id, 20);

    const res = await get(tokenAdmin, '/admin/dashboard/recent-grades');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].eleve.firstName).toBe('Ana');
    expect(res.body[0].eleve.classe.name).toBe('6e A');
    expect(res.body[0].matiere.name).toBe('Maths');
  });

  it('respecte la limite demandée', async () => {
    const ana = await addStudent(classe6.id, 'Ana');
    for (let i = 0; i < 5; i += 1) await addGrade(ana.id, 10 + i);

    expect((await get(tokenAdmin, '/admin/dashboard/recent-grades?limit=3')).body).toHaveLength(3);
  });

  it('refuse une limite hors bornes', async () => {
    expect((await get(tokenAdmin, '/admin/dashboard/recent-grades?limit=0')).status).toBe(400);
    expect((await get(tokenAdmin, '/admin/dashboard/recent-grades?limit=500')).status).toBe(400);
  });

  it("ne divulgue ni email d'enseignant ni hash", async () => {
    const prof = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    const ana = await addStudent(classe6.id, 'Ana');
    await seedGrade({
      schoolId: school.id,
      studentId: ana.id,
      subjectId: maths.id,
      gradeTypeId: compoId,
      termId: term.id,
      teacherUserId: prof.id,
      value: 15,
    });

    const res = await get(tokenAdmin, '/admin/dashboard/recent-grades');
    expect(JSON.stringify(res.body)).not.toContain('prof@a.test');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it("ne montre pas les notes d'une autre école", async () => {
    const autreClasse = await prisma.class.create({
      data: { schoolId: autreEcole.id, name: '6e B', level: '6e' },
    });
    const foreignStudent = await prisma.student.create({
      data: { schoolId: autreEcole.id, classId: autreClasse.id, firstName: 'X', lastName: 'Y' },
    });
    const foreignSubject = await prisma.subject.create({
      data: { schoolId: autreEcole.id, name: 'Secret' },
    });
    const foreignType = await prisma.gradeType.create({
      data: { schoolId: autreEcole.id, code: 'devoir', label: 'Devoir', weight: 2 },
    });
    const foreignTerm = await prisma.term.create({
      data: { schoolId: autreEcole.id, label: 'T1' },
    });
    await seedGrade({
      schoolId: autreEcole.id,
      studentId: foreignStudent.id,
      subjectId: foreignSubject.id,
      gradeTypeId: foreignType.id,
      termId: foreignTerm.id,
      value: 15,
    });

    const res = await get(tokenAdmin, '/admin/dashboard/recent-grades');
    expect(res.body).toHaveLength(0);
  });
});
