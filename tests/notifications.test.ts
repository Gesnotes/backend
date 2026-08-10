import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase, seedEvaluation, seedGrade } from './helpers';
import { createApp } from '../src/app';
import { notifyParents } from '../src/services/notification.service';
import { pushSender } from '../src/lib/push';
import { webAppUrl } from '../src/lib/env';
import { signAccessToken } from '../src/lib/jwt';

const app = createApp();

let school: { id: number };
let parentA: { id: number };
let tokenParentA: string;
let tokenProf: string;
let ana: { id: number };
let note: { id: number; studentId: number; subjectId: number; termId: number; schoolId: number };

const event = () => ({
  gradeId: note.id,
  schoolId: note.schoolId,
  studentId: note.studentId,
  subjectId: note.subjectId,
  termId: note.termId,
});

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');
  parentA = await createUser({ schoolId: school.id, email: 'pa@a.test', role: 'parent' });
  const prof = await createUser({ schoolId: school.id, email: 'prof@a.test', role: 'teacher' });

  tokenParentA = signAccessToken({ userId: parentA.id, schoolId: school.id, role: 'parent' });
  tokenProf = signAccessToken({ userId: prof.id, schoolId: school.id, role: 'teacher' });

  const classe = await prisma.class.create({
    data: { schoolId: school.id, name: '6e A', level: '6e' },
  });
  const maths = await prisma.subject.create({ data: { schoolId: school.id, name: 'Maths' } });
  const term = await prisma.term.create({ data: { schoolId: school.id, label: 'T1' } });
  const compo = await prisma.gradeType.create({
    data: { schoolId: school.id, code: 'composition', label: 'Composition', weight: 3 },
  });

  ana = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ana', lastName: 'Alpha' },
  });
  await prisma.studentParent.create({ data: { studentId: ana.id, parentUserId: parentA.id } });

  note = await seedGrade({
    schoolId: school.id,
    studentId: ana.id,
    subjectId: maths.id,
    gradeTypeId: compo.id,
    termId: term.id,
    teacherUserId: prof.id,
    value: 15,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const api = (token: string) => ({
  get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
  post: (p: string) => request(app).post(p).set('Authorization', `Bearer ${token}`),
  delete: (p: string) => request(app).delete(p).set('Authorization', `Bearer ${token}`),
});

const TOKEN_1 = 'fcm-token-appareil-1';
const TOKEN_2 = 'fcm-token-appareil-2';

describe('enregistrement des appareils', () => {
  it('enregistre un token et le retire', async () => {
    const created = await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    expect(created.status).toBe(201);

    expect((await api(tokenParentA).get('/parents/me/devices')).body).toHaveLength(1);

    expect((await api(tokenParentA).delete(`/parents/me/devices/${TOKEN_1}`)).status).toBe(204);
    expect(await prisma.device.count()).toBe(0);
  });

  it('est idempotent : réenregistrer le même token ne crée pas de doublon', async () => {
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });

    expect(await prisma.device.count()).toBe(1);
  });

  it('accepte plusieurs appareils pour un même parent', async () => {
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_2 });

    expect((await api(tokenParentA).get('/parents/me/devices')).body).toHaveLength(2);
  });

  it("réattribue un token repris par un autre compte", async () => {
    const autreParent = await createUser({ schoolId: school.id, email: 'pb@a.test', role: 'parent' });
    const tokenB = signAccessToken({ userId: autreParent.id, schoolId: school.id, role: 'parent' });

    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    // Téléphone revendu ou réinstallé : le token doit suivre le nouveau compte
    // plutôt que d'être rejeté en doublon — sinon l'ancien parent continuerait
    // de recevoir les notes d'un enfant qui n'est pas le sien.
    const res = await api(tokenB).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });

    expect(res.status).toBe(201);
    expect(await prisma.device.count()).toBe(1);
    const device = await prisma.device.findUniqueOrThrow({ where: { fcmToken: TOKEN_1 } });
    expect(device.userId).toBe(autreParent.id);
  });

  it("ne retire pas l'appareil d'un autre parent", async () => {
    const autreParent = await createUser({ schoolId: school.id, email: 'pb@a.test', role: 'parent' });
    const tokenB = signAccessToken({ userId: autreParent.id, schoolId: school.id, role: 'parent' });

    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });

    expect((await api(tokenB).delete(`/parents/me/devices/${TOKEN_1}`)).status).toBe(404);
    expect(await prisma.device.count()).toBe(1);
  });

  it('est refusé à un enseignant', async () => {
    const res = await api(tokenProf).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    expect(res.status).toBe(403);
  });
});

describe('envoi des notifications', () => {
  it('notifie tous les appareils des parents de l\'élève', async () => {
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_2 });

    const spy = vi.spyOn(pushSender, 'send').mockResolvedValue({ invalidTokens: [] });
    await notifyParents(event(), 'nouvelle');

    expect(spy).toHaveBeenCalledOnce();
    const [tokens, message] = spy.mock.calls[0]!;
    expect(tokens).toHaveLength(2);
    expect(message.title).toContain('Ana');
    expect(message.body).toContain('Maths');
    expect(message.body).toContain('15/20');
    expect(message.data).toMatchObject({ gradeId: String(note.id) });
  });

  /**
   * Sans lien, le parent reçoit « Ana a une nouvelle note » et atterrit sur
   * l'accueil, à charge pour lui de retrouver la note.
   */
  it('pointe la notification sur la note concernée', async () => {
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });

    const spy = vi.spyOn(pushSender, 'send').mockResolvedValue({ invalidTokens: [] });
    await notifyParents(event(), 'nouvelle');

    expect(spy.mock.calls[0]![1].link).toBe(`${webAppUrl}/parent/notes/${note.id}`);
  });

  it('distingue une note modifiée d\'une nouvelle note', async () => {
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });

    const spy = vi.spyOn(pushSender, 'send').mockResolvedValue({ invalidTokens: [] });
    await notifyParents(event(), 'modifiee');

    expect(spy.mock.calls[0]![1].title).toMatch(/modifiée/i);
  });

  it("n'envoie rien si le parent n'a aucun appareil", async () => {
    const spy = vi.spyOn(pushSender, 'send');
    await notifyParents(event(), 'nouvelle');
    expect(spy).not.toHaveBeenCalled();
  });

  it("n'envoie rien pour un élève archivé", async () => {
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    await prisma.student.update({ where: { id: ana.id }, data: { archivedAt: new Date() } });

    const spy = vi.spyOn(pushSender, 'send');
    await notifyParents(event(), 'nouvelle');
    expect(spy).not.toHaveBeenCalled();
  });

  it("n'envoie pas aux appareils d'un parent archivé", async () => {
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    await prisma.user.update({ where: { id: parentA.id }, data: { archivedAt: new Date() } });

    const spy = vi.spyOn(pushSender, 'send');
    await notifyParents(event(), 'nouvelle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('purge les tokens rejetés définitivement par FCM', async () => {
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_2 });

    vi.spyOn(pushSender, 'send').mockResolvedValue({ invalidTokens: [TOKEN_1] });
    await notifyParents(event(), 'nouvelle');

    // L'appareil désinstallé disparaît, l'autre reste.
    const remaining = await prisma.device.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.fcmToken).toBe(TOKEN_2);
  });
});

describe('découplage de la saisie', () => {
  it('enregistre la note même si FCM est en panne', async () => {
    await api(tokenParentA).post('/parents/me/devices').send({ fcmToken: TOKEN_1 });
    vi.spyOn(pushSender, 'send').mockRejectedValue(new Error('FCM indisponible'));

    const classe = await prisma.class.findFirstOrThrow({ where: { schoolId: school.id } });
    const maths = await prisma.subject.findFirstOrThrow({ where: { schoolId: school.id } });
    const term = await prisma.term.findFirstOrThrow({ where: { schoolId: school.id } });
    const type = await prisma.gradeType.findFirstOrThrow({ where: { schoolId: school.id } });
    const prof = await prisma.user.findFirstOrThrow({ where: { email: 'prof@a.test' } });
    await prisma.teacherAssignment.create({
      data: { schoolId: school.id, teacherUserId: prof.id, classId: classe.id, subjectId: maths.id },
    });

    const evaluation = await seedEvaluation({
      schoolId: school.id,
      classId: classe.id,
      subjectId: maths.id,
      gradeTypeId: type.id,
      termId: term.id,
      teacherUserId: prof.id,
    });

    const res = await api(tokenProf).post('/grades').send({
      evaluationId: evaluation.id,
      studentId: ana.id,
      value: 12,
    });

    // La saisie réussit : l'envoi push est hors du cycle requête/réponse.
    expect(res.status).toBe(201);
    expect(await prisma.grade.count()).toBe(2);

    // Et l'échec d'envoi ne remonte pas en exception non gérée.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
