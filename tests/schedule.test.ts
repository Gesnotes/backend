import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createApp } from '../src/app';
import { createSchool, createUser, resetDatabase } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let schoolA: { id: number };
let schoolB: { id: number };
let adminToken: string;
let teacherX: { id: number };
let teacherY: { id: number };
let teacherXToken: string;
let teacherYToken: string;
let classA: { id: number };
let presenceClass: { id: number };
let subjectA: { id: number };
let subjectB: { id: number };
let assignmentX: { id: number }; // teacherX × classA × subjectA
let assignmentY: { id: number }; // teacherY × classA × subjectB

beforeEach(async () => {
  await resetDatabase();

  schoolA = await createSchool('ecole-a');
  schoolB = await createSchool('ecole-b');

  const admin = await createUser({ schoolId: schoolA.id, email: 'admin@a.test', role: 'admin' });
  teacherX = await createUser({ schoolId: schoolA.id, email: 'x@a.test', role: 'teacher' });
  teacherY = await createUser({ schoolId: schoolA.id, email: 'y@a.test', role: 'teacher' });

  adminToken = signAccessToken({ userId: admin.id, schoolId: schoolA.id, role: 'admin' });
  teacherXToken = signAccessToken({ userId: teacherX.id, schoolId: schoolA.id, role: 'teacher' });
  teacherYToken = signAccessToken({ userId: teacherY.id, schoolId: schoolA.id, role: 'teacher' });

  classA = await prisma.class.create({ data: { schoolId: schoolA.id, name: '6e A', level: '6e', mode: 'notes' } });
  presenceClass = await prisma.class.create({
    data: { schoolId: schoolA.id, name: 'Petite section', level: 'maternelle', mode: 'presence' },
  });
  subjectA = await prisma.subject.create({ data: { schoolId: schoolA.id, name: 'Maths' } });
  subjectB = await prisma.subject.create({ data: { schoolId: schoolA.id, name: 'Français' } });

  assignmentX = await prisma.teacherAssignment.create({
    data: { schoolId: schoolA.id, teacherUserId: teacherX.id, classId: classA.id, subjectId: subjectA.id },
  });
  assignmentY = await prisma.teacherAssignment.create({
    data: { schoolId: schoolA.id, teacherUserId: teacherY.id, classId: classA.id, subjectId: subjectB.id },
  });
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

const createSlotBody = (overrides: Partial<Record<string, unknown>> = {}) => ({
  teacherAssignmentId: assignmentX.id,
  dayOfWeek: 'lundi',
  startTime: '08:00',
  endTime: '09:00',
  ...overrides,
});

describe('GET /classes/:id/schedule', () => {
  it("liste vide au départ, admin voit l'emploi du temps", async () => {
    const res = await api(adminToken).get(`/classes/${classA.id}/schedule`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('un enseignant affecté à la classe peut consulter', async () => {
    const res = await api(teacherXToken).get(`/classes/${classA.id}/schedule`);
    expect(res.status).toBe(200);
  });

  it("un enseignant qui n'y enseigne pas est refusé", async () => {
    const foreign = await createUser({ schoolId: schoolA.id, email: 'z@a.test', role: 'teacher' });
    const foreignToken = signAccessToken({ userId: foreign.id, schoolId: schoolA.id, role: 'teacher' });
    const res = await api(foreignToken).get(`/classes/${classA.id}/schedule`);
    expect(res.status).toBe(403);
  });

  it("renvoie 404 pour une classe d'une autre école", async () => {
    const classB = await prisma.class.create({ data: { schoolId: schoolB.id, name: '6e B', level: '6e' } });
    const res = await api(adminToken).get(`/classes/${classB.id}/schedule`);
    expect(res.status).toBe(404);
  });
});

describe('POST /classes/:id/schedule', () => {
  it('admin crée un créneau', async () => {
    const res = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    expect(res.status).toBe(201);
    expect(res.body.subjectName).toBe('Maths');
    expect(res.body.className).toBe('6e A');
    expect(res.body.dayOfWeek).toBe('lundi');
    expect(res.body.startTime).toBe('08:00');
    expect(res.body.endTime).toBe('09:00');
    expect(res.body.archivedAt).toBeNull();
  });

  it('interdit la création à un enseignant', async () => {
    const res = await api(teacherXToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    expect(res.status).toBe(403);
  });

  it('refuse un horaire mal formé', async () => {
    const res = await api(adminToken)
      .post(`/classes/${classA.id}/schedule`)
      .send(createSlotBody({ startTime: '8h00' }));
    expect(res.status).toBe(400);
  });

  it('refuse une heure de fin avant ou égale à l’heure de début', async () => {
    const res = await api(adminToken)
      .post(`/classes/${classA.id}/schedule`)
      .send(createSlotBody({ startTime: '09:00', endTime: '09:00' }));
    expect(res.status).toBe(400);
  });

  it('refuse un créneau sur une classe en mode présence', async () => {
    const assignment = await prisma.teacherAssignment.create({
      data: { schoolId: schoolA.id, teacherUserId: teacherX.id, classId: presenceClass.id, subjectId: subjectA.id },
    });
    const res = await api(adminToken)
      .post(`/classes/${presenceClass.id}/schedule`)
      .send(createSlotBody({ teacherAssignmentId: assignment.id }));
    expect(res.status).toBe(400);
  });

  it("refuse une affectation qui n'appartient pas à cette classe", async () => {
    const otherClass = await prisma.class.create({ data: { schoolId: schoolA.id, name: '5e A', level: '5e' } });
    const res = await api(adminToken).post(`/classes/${otherClass.id}/schedule`).send(createSlotBody());
    expect(res.status).toBe(404);
  });

  it("refuse une affectation d'une autre école", async () => {
    const teacherB = await createUser({ schoolId: schoolB.id, email: 'b@b.test', role: 'teacher' });
    const classB = await prisma.class.create({ data: { schoolId: schoolB.id, name: '6e B', level: '6e' } });
    const subjectBB = await prisma.subject.create({ data: { schoolId: schoolB.id, name: 'SVT' } });
    const foreignAssignment = await prisma.teacherAssignment.create({
      data: { schoolId: schoolB.id, teacherUserId: teacherB.id, classId: classB.id, subjectId: subjectBB.id },
    });

    const res = await api(adminToken)
      .post(`/classes/${classA.id}/schedule`)
      .send(createSlotBody({ teacherAssignmentId: foreignAssignment.id }));
    expect(res.status).toBe(404);
  });

  it('refuse deux créneaux qui se chevauchent pour le même enseignant', async () => {
    await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());

    const otherClassSameTeacher = await prisma.class.create({
      data: { schoolId: schoolA.id, name: '5e A', level: '5e', mode: 'notes' },
    });
    const assignment = await prisma.teacherAssignment.create({
      data: { schoolId: schoolA.id, teacherUserId: teacherX.id, classId: otherClassSameTeacher.id, subjectId: subjectA.id },
    });

    const res = await api(adminToken)
      .post(`/classes/${otherClassSameTeacher.id}/schedule`)
      .send(createSlotBody({ teacherAssignmentId: assignment.id, startTime: '08:30', endTime: '09:30' }));
    expect(res.status).toBe(409);
  });

  it('refuse deux créneaux qui se chevauchent pour la même classe', async () => {
    await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());

    const res = await api(adminToken)
      .post(`/classes/${classA.id}/schedule`)
      .send(createSlotBody({ teacherAssignmentId: assignmentY.id, startTime: '08:30', endTime: '09:30' }));
    expect(res.status).toBe(409);
  });

  it('accepte deux créneaux consécutifs (pas de chevauchement)', async () => {
    await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());

    const res = await api(adminToken)
      .post(`/classes/${classA.id}/schedule`)
      .send(createSlotBody({ teacherAssignmentId: assignmentY.id, startTime: '09:00', endTime: '10:00' }));
    expect(res.status).toBe(201);
  });

  it('accepte le même horaire un autre jour', async () => {
    await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());

    const res = await api(adminToken)
      .post(`/classes/${classA.id}/schedule`)
      .send(createSlotBody({ teacherAssignmentId: assignmentY.id, dayOfWeek: 'mardi' }));
    expect(res.status).toBe(201);
  });
});

describe('PATCH /classes/:id/schedule/:slotId', () => {
  it("admin modifie l'horaire", async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    const res = await api(adminToken)
      .patch(`/classes/${classA.id}/schedule/${created.body.id}`)
      .send({ startTime: '10:00', endTime: '11:00' });
    expect(res.status).toBe(200);
    expect(res.body.startTime).toBe('10:00');
  });

  it('interdit la modification à un enseignant', async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    const res = await api(teacherXToken)
      .patch(`/classes/${classA.id}/schedule/${created.body.id}`)
      .send({ startTime: '10:00', endTime: '11:00' });
    expect(res.status).toBe(403);
  });

  it('revérifie le chevauchement en excluant le créneau modifié', async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    // Ne se chevauche pas avec lui-même : le déplacer de 30 min doit passer.
    const res = await api(adminToken)
      .patch(`/classes/${classA.id}/schedule/${created.body.id}`)
      .send({ startTime: '08:30', endTime: '09:30' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /classes/:id/schedule/:slotId — archive et suppression définitive', () => {
  it('archive par défaut, sans détruire', async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());

    const res = await api(adminToken).delete(`/classes/${classA.id}/schedule/${created.body.id}`);
    expect(res.status).toBe(204);

    expect((await api(adminToken).get(`/classes/${classA.id}/schedule`)).body).toEqual([]);
    const withArchived = await api(adminToken).get(`/classes/${classA.id}/schedule?include_archived=true`);
    expect(withArchived.body).toHaveLength(1);
    expect(withArchived.body[0].archivedAt).not.toBeNull();
  });

  it('restaure un créneau archivé', async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    await api(adminToken).delete(`/classes/${classA.id}/schedule/${created.body.id}`);

    const res = await api(adminToken).post(`/classes/${classA.id}/schedule/${created.body.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.archivedAt).toBeNull();
  });

  it('refuse de restaurer un créneau redevenu incompatible', async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    await api(adminToken).delete(`/classes/${classA.id}/schedule/${created.body.id}`);

    // Un nouveau créneau prend la place laissée libre par l'archivage.
    await api(adminToken)
      .post(`/classes/${classA.id}/schedule`)
      .send(createSlotBody({ teacherAssignmentId: assignmentY.id }));

    const res = await api(adminToken).post(`/classes/${classA.id}/schedule/${created.body.id}/restore`);
    expect(res.status).toBe(409);
  });

  it('refuse la suppression définitive tant que le créneau n’est pas archivé', async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());

    const res = await api(adminToken).delete(
      `/classes/${classA.id}/schedule/${created.body.id}?permanent=true&confirm_label=x`,
    );
    expect(res.status).toBe(409);
  });

  it('refuse la suppression définitive si la confirmation ne correspond pas', async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    await api(adminToken).delete(`/classes/${classA.id}/schedule/${created.body.id}`);

    const res = await api(adminToken).delete(
      `/classes/${classA.id}/schedule/${created.body.id}?permanent=true&confirm_label=mauvais`,
    );
    expect(res.status).toBe(400);
  });

  it('supprime définitivement avec le libellé exact', async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    await api(adminToken).delete(`/classes/${classA.id}/schedule/${created.body.id}`);

    const label = 'Maths · 6e A · Lundi 08:00-09:00';
    const res = await api(adminToken).delete(
      `/classes/${classA.id}/schedule/${created.body.id}?permanent=true&confirm_label=${encodeURIComponent(label)}`,
    );
    expect(res.status).toBe(204);
    expect(await prisma.timetableSlot.count()).toBe(0);
  });
});

describe('changement de mode de classe avec créneaux actifs', () => {
  it('refuse de repasser une classe notes → presence si elle a un emploi du temps actif', async () => {
    await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());

    const res = await api(adminToken).patch(`/classes/${classA.id}`).send({ mode: 'presence' });
    expect(res.status).toBe(409);
  });

  it('accepte le passage en mode présence une fois les créneaux archivés puis supprimés', async () => {
    const created = await api(adminToken).post(`/classes/${classA.id}/schedule`).send(createSlotBody());
    await api(adminToken).delete(`/classes/${classA.id}/schedule/${created.body.id}`);

    // Archivé mais toujours rattaché à la classe : le garde-fou ne compte
    // que les créneaux actifs, un archivé ne bloque donc plus le passage.
    const res = await api(adminToken).patch(`/classes/${classA.id}`).send({ mode: 'presence' });
    expect(res.status).toBe(200);
  });
});
