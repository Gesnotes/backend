import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'] as const;
const todayIso = () => new Date().toISOString().slice(0, 10);
const todayWeekday = () => WEEKDAYS[new Date().getUTCDay()]!;
const otherWeekday = () => WEEKDAYS[(new Date().getUTCDay() + 1) % 7]!;

let schoolA: { id: number };
let adminToken: string;
let teacherXToken: string;
let teacherYToken: string;
let classA: { id: number }; // mode notes
let presenceClass: { id: number };
let slotX: { id: number }; // teacherX × classA × Maths, aujourd'hui 08:00-09:00
let students: { id: number }[];

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  const teacherX = await createUser({ schoolId: schoolA.id, email: 'x@a.test', role: 'teacher' });
  const teacherY = await createUser({ schoolId: schoolA.id, email: 'y@a.test', role: 'teacher' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherXToken = signAccessToken({ userId: teacherX.id, schoolId: schoolA.id, role: 'teacher' });
  teacherYToken = signAccessToken({ userId: teacherY.id, schoolId: schoolA.id, role: 'teacher' });

  classA = await prisma.class.create({ data: { schoolId: schoolA.id, name: '3e A', level: '3e', mode: 'notes' } });
  presenceClass = await prisma.class.create({
    data: { schoolId: schoolA.id, name: 'Garderie', level: 'maternelle', mode: 'presence' },
  });
  const subjectA = await prisma.subject.create({ data: { schoolId: schoolA.id, name: 'Maths' } });

  const assignmentX = await prisma.teacherAssignment.create({
    data: { schoolId: schoolA.id, teacherUserId: teacherX.id, classId: classA.id, subjectId: subjectA.id },
  });

  slotX = await prisma.timetableSlot.create({
    data: {
      schoolId: schoolA.id,
      teacherAssignmentId: assignmentX.id,
      dayOfWeek: todayWeekday(),
      startMinute: 480,
      endMinute: 540,
    },
  });

  students = [];
  for (const name of ['Adjovi', 'Kossi']) {
    students.push(
      await prisma.student.create({
        data: { schoolId: schoolA.id, classId: classA.id, firstName: name, lastName: 'Test' },
      }),
    );
  }
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  put: (p: string) => request(app).put(p).set('Authorization', `Bearer ${token}`),
});

const batch = (slotId: number) => ({
  slotId,
  date: todayIso(),
  entries: students.map((s) => ({ studentId: s.id, status: 'present' as const })),
});

describe('PUT /teachers/me/attendance — créneau (mode notes)', () => {
  it("l'enseignant du créneau peut saisir la présence", async () => {
    const res = await api(teacherXToken).put('/teachers/me/attendance').send(batch(slotX.id));
    expect(res.status).toBe(200);
    expect(await prisma.attendance.count({ where: { slotId: slotX.id } })).toBe(2);
  });

  it("l'administration peut saisir la présence de n'importe quel créneau", async () => {
    const res = await api(adminToken).put('/teachers/me/attendance').send(batch(slotX.id));
    expect(res.status).toBe(200);
  });

  it("un autre enseignant que celui du créneau est refusé", async () => {
    const res = await api(teacherYToken).put('/teachers/me/attendance').send(batch(slotX.id));
    expect(res.status).toBe(403);
  });

  it('refuse la classe et le créneau en même temps', async () => {
    const res = await api(teacherXToken)
      .put('/teachers/me/attendance')
      .send({ classId: classA.id, slotId: slotX.id, date: todayIso(), entries: batch(slotX.id).entries });
    expect(res.status).toBe(400);
  });

  it('refuse sans classe ni créneau', async () => {
    const res = await api(teacherXToken)
      .put('/teachers/me/attendance')
      .send({ date: todayIso(), entries: batch(slotX.id).entries });
    expect(res.status).toBe(400);
  });

  it("refuse la classe (mode notes) par classId : elle exige un créneau", async () => {
    const res = await api(adminToken)
      .put('/teachers/me/attendance')
      .send({ classId: classA.id, date: todayIso(), entries: batch(slotX.id).entries });
    expect(res.status).toBe(400);
  });

  it("refuse un créneau qui n'a pas cours ce jour-là", async () => {
    // Créneau posé un autre jour que celui du test : la date du jour ne
    // correspond plus à son dayOfWeek.
    const decale = await prisma.timetableSlot.create({
      data: {
        schoolId: schoolA.id,
        teacherAssignmentId: (await prisma.teacherAssignment.findFirstOrThrow({ where: { classId: classA.id } })).id,
        dayOfWeek: otherWeekday(),
        startMinute: 600,
        endMinute: 660,
      },
    });
    const decaleRes = await api(teacherXToken).put('/teachers/me/attendance').send(batch(decale.id));
    expect(decaleRes.status).toBe(400);
  });

  it('refuse un créneau archivé', async () => {
    await prisma.timetableSlot.update({ where: { id: slotX.id }, data: { archivedAt: new Date() } });
    const res = await api(teacherXToken).put('/teachers/me/attendance').send(batch(slotX.id));
    expect(res.status).toBe(409);
  });

  it('refuse un créneau inconnu', async () => {
    const res = await api(teacherXToken).put('/teachers/me/attendance').send(batch(999999));
    expect(res.status).toBe(404);
  });
});

describe('GET /teachers/me/attendance — créneau', () => {
  it('renvoie la feuille du créneau avec la matière et l’horaire', async () => {
    const res = await api(teacherXToken).get(
      `/teachers/me/attendance?slot_id=${slotX.id}&date=${todayIso()}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.classId).toBe(classA.id);
    expect(res.body.slotId).toBe(slotX.id);
    expect(res.body.slot).toMatchObject({ subjectName: 'Maths', startTime: '08:00', endTime: '09:00' });
    expect(res.body.students).toHaveLength(2);
  });

  it("refuse un enseignant qui n'est pas celui du créneau", async () => {
    const res = await api(teacherYToken).get(
      `/teachers/me/attendance?slot_id=${slotX.id}&date=${todayIso()}`,
    );
    expect(res.status).toBe(403);
  });

  it('refuse class_id et slot_id en même temps', async () => {
    const res = await api(teacherXToken).get(
      `/teachers/me/attendance?class_id=${classA.id}&slot_id=${slotX.id}&date=${todayIso()}`,
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /teachers/me/schedule — mes créneaux du jour', () => {
  it('liste les créneaux du jour du professeur connecté', async () => {
    const res = await api(teacherXToken).get(`/teachers/me/schedule?date=${todayIso()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: slotX.id,
      classId: classA.id,
      subjectName: 'Maths',
      startTime: '08:00',
      endTime: '09:00',
    });
  });

  it("ne renvoie rien pour un enseignant sans créneau ce jour-là", async () => {
    const res = await api(teacherYToken).get(`/teachers/me/schedule?date=${todayIso()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("est réservée aux enseignants", async () => {
    const res = await api(adminToken).get(`/teachers/me/schedule?date=${todayIso()}`);
    expect(res.status).toBe(403);
  });
});

describe('mode presence — inchangé', () => {
  it('continue de fonctionner par classId, sans créneau', async () => {
    const referent = await createUser({ schoolId: schoolA.id, email: 'ref@a.test', role: 'teacher' });
    await prisma.class.update({ where: { id: presenceClass.id }, data: { homeroomTeacherId: referent.id } });
    const eleve = await prisma.student.create({
      data: { schoolId: schoolA.id, classId: presenceClass.id, firstName: 'Ana', lastName: 'Nom' },
    });
    const refToken = signAccessToken({ userId: referent.id, schoolId: schoolA.id, role: 'teacher' });

    const res = await api(refToken)
      .put('/teachers/me/attendance')
      .send({ classId: presenceClass.id, date: todayIso(), entries: [{ studentId: eleve.id, status: 'present' }] });
    expect(res.status).toBe(200);
  });
});
