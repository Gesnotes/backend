import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase, seedAttendance } from './helpers';
import { notifyParentsOfAttendance } from '../src/services/notification.service';
import { pushSender } from '../src/lib/push';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number };
let adminToken: string;
let referentToken: string;
let otherTeacherToken: string;
let parentToken: string;
let referent: { id: number };
let klass: { id: number };
let otherClass: { id: number };
let students: { id: number }[];

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  referent = await createUser({ schoolId: schoolA.id, email: 'referent@a.test', role: 'teacher' });
  const other = await createUser({ schoolId: schoolA.id, email: 'autre@a.test', role: 'teacher' });
  const parent = await createUser({ schoolId: schoolA.id, email: 'parent@a.test', role: 'parent' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  referentToken = signAccessToken({ userId: referent.id, schoolId: schoolA.id, role: 'teacher' });
  otherTeacherToken = signAccessToken({ userId: other.id, schoolId: schoolA.id, role: 'teacher' });
  parentToken = signAccessToken({ userId: parent.id, schoolId: schoolA.id, role: 'parent' });

  klass = await prisma.class.create({
    data: { schoolId: schoolA.id, name: 'Petite section', level: 'maternelle', mode: 'presence', homeroomTeacherId: referent.id },
  });
  otherClass = await prisma.class.create({
    data: { schoolId: schoolA.id, name: '6e A', level: '6e' },
  });

  students = [];
  for (const name of ['Adjovi', 'Kossi', 'Mawuena']) {
    students.push(
      await prisma.student.create({
        data: { schoolId: schoolA.id, classId: klass.id, firstName: name, lastName: 'Test' },
      }),
    );
  }
  await prisma.studentParent.create({ data: { studentId: students[0]!.id, parentUserId: parent.id } });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  put: (p: string) => request(app).put(p).set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(p).set('Authorization', `Bearer ${token}`),
});

const DATE = '2026-08-06';

const batch = (
  entries: { studentId: number; status: 'present' | 'absent' | 'late' | null; comment?: string | null }[],
  classId = klass.id,
  date = DATE,
) => ({ classId, date, entries });

describe('PUT /teachers/me/attendance', () => {
  it('enregistre la présence de toute la classe en une requête', async () => {
    const res = await api(adminToken).put('/teachers/me/attendance').send(
      batch(students.map((s, i) => ({ studentId: s.id, status: i === 0 ? 'absent' : 'present' }))),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 3, updated: 0, deleted: 0, unchanged: 0 });
    expect(await prisma.attendance.count()).toBe(3);
  });

  it("laisse le référent de la classe saisir la présence", async () => {
    const res = await api(referentToken)
      .put('/teachers/me/attendance')
      .send(batch([{ studentId: students[0]!.id, status: 'present' }]));
    expect(res.status).toBe(200);
  });

  it('est idempotent : rejouer le même lot ne crée aucun doublon', async () => {
    const payload = batch(students.map((s) => ({ studentId: s.id, status: 'present' })));

    await api(adminToken).put('/teachers/me/attendance').send(payload);
    const second = await api(adminToken).put('/teachers/me/attendance').send(payload);

    expect(second.body).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(await prisma.attendance.count()).toBe(3);
  });

  it('met à jour le statut modifié et laisse les autres intacts', async () => {
    await api(adminToken)
      .put('/teachers/me/attendance')
      .send(batch(students.map((s) => ({ studentId: s.id, status: 'present' }))));

    const res = await api(adminToken).put('/teachers/me/attendance').send(
      batch([
        { studentId: students[0]!.id, status: 'late' },
        { studentId: students[1]!.id, status: 'present' },
        { studentId: students[2]!.id, status: 'present' },
      ]),
    );

    expect(res.body).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
    const updated = await prisma.attendance.findFirst({ where: { studentId: students[0]!.id } });
    expect(updated?.status).toBe('late');
  });

  it('supprime l’enregistrement quand le statut est nul', async () => {
    await api(adminToken)
      .put('/teachers/me/attendance')
      .send(batch(students.map((s) => ({ studentId: s.id, status: 'present' }))));

    const res = await api(adminToken).put('/teachers/me/attendance').send(
      batch([
        { studentId: students[0]!.id, status: null },
        { studentId: students[1]!.id, status: 'present' },
        { studentId: students[2]!.id, status: 'present' },
      ]),
    );

    expect(res.body).toMatchObject({ deleted: 1, unchanged: 2 });
    expect(await prisma.attendance.count()).toBe(2);
  });

  it('enregistre les commentaires', async () => {
    await api(adminToken)
      .put('/teachers/me/attendance')
      .send(batch([{ studentId: students[0]!.id, status: 'absent', comment: 'Certificat médical' }]));

    const record = await prisma.attendance.findFirst({ where: { studentId: students[0]!.id } });
    expect(record?.comment).toBe('Certificat médical');
  });

  it('refuse un élève présent deux fois dans le lot', async () => {
    const res = await api(adminToken).put('/teachers/me/attendance').send(
      batch([
        { studentId: students[0]!.id, status: 'present' },
        { studentId: students[0]!.id, status: 'absent' },
      ]),
    );

    expect(res.status).toBe(400);
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('signale les élèves d’une autre classe sans échouer', async () => {
    const outsider = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: otherClass.id, firstName: 'Hors', lastName: 'Classe' },
    });

    const res = await api(adminToken).put('/teachers/me/attendance').send(
      batch([
        { studentId: students[0]!.id, status: 'present' },
        { studentId: outsider.id, status: 'present' },
      ]),
    );

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toEqual([{ studentId: outsider.id, reason: 'eleve_hors_classe' }]);
  });

  it('ignore un élève archivé', async () => {
    await prisma.student.update({ where: { id: students[0]!.id }, data: { archivedAt: new Date() } });

    const res = await api(adminToken)
      .put('/teachers/me/attendance')
      .send(batch([{ studentId: students[0]!.id, status: 'present' }]));

    expect(res.body.created).toBe(0);
    expect(res.body.skipped[0].reason).toBe('eleve_hors_classe');
  });

  it("refuse un enseignant qui n'est pas le référent de la classe", async () => {
    const res = await api(otherTeacherToken)
      .put('/teachers/me/attendance')
      .send(batch([{ studentId: students[0]!.id, status: 'present' }]));
    expect(res.status).toBe(403);
  });

  it('refuse un parent', async () => {
    const res = await api(parentToken)
      .put('/teachers/me/attendance')
      .send(batch([{ studentId: students[0]!.id, status: 'present' }]));
    expect(res.status).toBe(403);
  });

  it('refuse une classe inconnue', async () => {
    const res = await api(adminToken)
      .put('/teachers/me/attendance')
      .send(batch([{ studentId: students[0]!.id, status: 'present' }], 999999));
    expect(res.status).toBe(404);
  });

  it('valide la forme du corps', async () => {
    expect((await api(adminToken).put('/teachers/me/attendance').send({ entries: [] })).status).toBe(400);
    expect(
      (await api(adminToken).put('/teachers/me/attendance').send(batch([{ studentId: students[0]!.id, status: 'malade' as never }]))).status,
    ).toBe(400);
  });
});

describe('GET /teachers/me/attendance — feuille de présence', () => {
  it('renvoie tous les élèves de la classe avec leur statut, ou aucun', async () => {
    await seedAttendance({
      schoolId: schoolA.id,
      studentId: students[0]!.id,
      classId: klass.id,
      date: DATE,
      status: 'absent',
    });

    const res = await api(adminToken).get(`/teachers/me/attendance?class_id=${klass.id}&date=${DATE}`);

    expect(res.status).toBe(200);
    expect(res.body.students).toHaveLength(3);
    const first = res.body.students.find((s: { id: number }) => s.id === students[0]!.id);
    expect(first.status).toBe('absent');
    const second = res.body.students.find((s: { id: number }) => s.id === students[1]!.id);
    expect(second.status).toBeNull();
  });

  it("refuse un enseignant qui n'est pas le référent", async () => {
    const res = await api(otherTeacherToken).get(`/teachers/me/attendance?class_id=${klass.id}&date=${DATE}`);
    expect(res.status).toBe(403);
  });
});

describe('mode présence — garde-fou sur les évaluations', () => {
  it("refuse de créer une évaluation sur une classe en mode présence", async () => {
    const subject = await prisma.subject.create({ data: { schoolId: schoolA.id, name: 'Éveil' } });
    const term = await prisma.term.create({ data: { schoolId: schoolA.id, label: 'Trimestre 1' } });
    const type = await prisma.gradeType.create({
      data: { schoolId: schoolA.id, code: 'devoir', label: 'Devoir', weight: 1 },
    });

    const res = await api(adminToken).post('/teachers/me/evaluations').send({
      classId: klass.id,
      subjectId: subject.id,
      gradeTypeId: type.id,
      termId: term.id,
      label: 'Interro',
    });

    expect(res.status).toBe(400);
    expect(await prisma.evaluation.count()).toBe(0);
  });
});

describe('GET /children/:id/attendance — historique du parent', () => {
  it("renvoie l'historique de présence de l'enfant", async () => {
    await seedAttendance({
      schoolId: schoolA.id,
      studentId: students[0]!.id,
      classId: klass.id,
      date: DATE,
      status: 'late',
    });

    const res = await api(parentToken).get(`/children/${students[0]!.id}/attendance`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ status: 'late' });
  });

  it("refuse un parent qui n'est pas celui de l'enfant", async () => {
    const res = await api(parentToken).get(`/children/${students[1]!.id}/attendance`);
    expect(res.status).toBe(404);
  });
});

describe('notification des parents en cas d’absence ou de retard', () => {
  const TOKEN = 'fcm-token-test';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notifie les parents en cas d’absence', async () => {
    const parent = await prisma.studentParent.findFirstOrThrow({ where: { studentId: students[0]!.id } });
    await prisma.device.create({ data: { userId: parent.parentUserId, fcmToken: TOKEN } });

    const attendance = await seedAttendance({
      schoolId: schoolA.id,
      studentId: students[0]!.id,
      classId: klass.id,
      date: DATE,
      status: 'absent',
    });

    const spy = vi.spyOn(pushSender, 'send').mockResolvedValue({ invalidTokens: [] });
    await notifyParentsOfAttendance({
      attendanceId: attendance.id,
      schoolId: schoolA.id,
      studentId: students[0]!.id,
      classId: klass.id,
      status: 'absent',
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![1].title).toMatch(/absent/i);
  });

  it('notifie les parents en cas de retard', async () => {
    const parent = await prisma.studentParent.findFirstOrThrow({ where: { studentId: students[0]!.id } });
    await prisma.device.create({ data: { userId: parent.parentUserId, fcmToken: TOKEN } });

    const attendance = await seedAttendance({
      schoolId: schoolA.id,
      studentId: students[0]!.id,
      classId: klass.id,
      date: DATE,
      status: 'late',
    });

    const spy = vi.spyOn(pushSender, 'send').mockResolvedValue({ invalidTokens: [] });
    await notifyParentsOfAttendance({
      attendanceId: attendance.id,
      schoolId: schoolA.id,
      studentId: students[0]!.id,
      classId: klass.id,
      status: 'late',
    });

    expect(spy.mock.calls[0]![1].title).toMatch(/retard/i);
  });

  it("n'envoie rien si le parent n'a aucun appareil", async () => {
    const attendance = await seedAttendance({
      schoolId: schoolA.id,
      studentId: students[0]!.id,
      classId: klass.id,
      date: DATE,
      status: 'absent',
    });

    const spy = vi.spyOn(pushSender, 'send');
    await notifyParentsOfAttendance({
      attendanceId: attendance.id,
      schoolId: schoolA.id,
      studentId: students[0]!.id,
      classId: klass.id,
      status: 'absent',
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it("dans un lot mixte, ne notifie que pour l'absence, jamais pour la présence", async () => {
    const parent = await prisma.studentParent.findFirstOrThrow({ where: { studentId: students[0]!.id } });
    await prisma.device.create({ data: { userId: parent.parentUserId, fcmToken: TOKEN } });

    const spy = vi.spyOn(pushSender, 'send').mockResolvedValue({ invalidTokens: [] });

    const res = await api(adminToken).put('/teachers/me/attendance').send(
      batch([
        { studentId: students[0]!.id, status: 'absent' },
        { studentId: students[1]!.id, status: 'present' },
      ]),
    );

    expect(res.status).toBe(200);
    // L'envoi est hors du cycle requête/réponse (setImmediate) : on laisse la
    // boucle d'événements tourner avant de vérifier.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spy).toHaveBeenCalledOnce();
  });
});
