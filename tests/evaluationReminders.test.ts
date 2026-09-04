import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import prisma from '../src/lib/prisma';
import { createSchool, createUser, resetDatabase, seedEvaluation } from './helpers';
import { sendEvaluationReminders } from '../src/services/evaluationReminder.service';

let school: { id: number };
let admin: { id: number };
let prof: { id: number };
let classe: { id: number };
let maths: { id: number };
let term: { id: number };
let devoirId: number;
let ana: { id: number };
let parentA: { id: number };

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d;
}

beforeEach(async () => {
  await resetDatabase();

  school = await createSchool('ecole-a');
  admin = await createUser({ schoolId: school.id, email: 'admin@a.test', role: 'admin' });
  prof = await createUser({ schoolId: school.id, email: 'prof@a.test', role: 'teacher' });
  parentA = await createUser({ schoolId: school.id, email: 'pa@a.test', role: 'parent' });

  classe = await prisma.class.create({ data: { schoolId: school.id, name: '6e A', level: '6e' } });
  maths = await prisma.subject.create({ data: { schoolId: school.id, name: 'Maths' } });
  term = await prisma.term.create({ data: { schoolId: school.id, label: 'Trimestre 1' } });

  const devoir = await prisma.gradeType.create({
    data: { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
  });
  devoirId = devoir.id;

  await prisma.teacherAssignment.create({
    data: { schoolId: school.id, teacherUserId: prof.id, classId: classe.id, subjectId: maths.id },
  });

  ana = await prisma.student.create({
    data: { schoolId: school.id, classId: classe.id, firstName: 'Ana', lastName: 'Alpha' },
  });
  await prisma.studentParent.create({
    data: { schoolId: school.id, studentId: ana.id, parentUserId: parentA.id },
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('sendEvaluationReminders', () => {
  it('envoie un rappel pour une évaluation exactement à J+3', async () => {
    const evaluation = await seedEvaluation({
      schoolId: school.id, classId: classe.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, teacherUserId: prof.id, label: 'Devoir de maths', date: daysFromNow(3),
    });

    const result = await sendEvaluationReminders();

    expect(result).toEqual({ sent: 1, failed: 0 });

    const notification = await prisma.notification.findFirst({ where: { schoolId: school.id } });
    expect(notification).toMatchObject({
      type: 'rappel',
      targetType: 'class_parents',
      targetId: classe.id,
      resourceType: 'evaluation',
      resourceId: evaluation.id,
      creatorUserId: prof.id,
    });

    const recipients = await prisma.notificationRecipient.findMany({
      where: { notificationId: notification!.id },
    });
    expect(recipients.map((r) => r.parentUserId)).toEqual([parentA.id]);

    const updated = await prisma.evaluation.findUniqueOrThrow({ where: { id: evaluation.id } });
    expect(updated.reminderSentAt).not.toBeNull();
  });

  it('ignore une évaluation à J+2 ou J+4 (bornes exactes, pas une fenêtre)', async () => {
    await seedEvaluation({
      schoolId: school.id, classId: classe.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, date: daysFromNow(2),
    });
    await seedEvaluation({
      schoolId: school.id, classId: classe.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, date: daysFromNow(4),
    });

    const result = await sendEvaluationReminders();

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(await prisma.notification.count()).toBe(0);
  });

  it("n'envoie pas deux fois le même rappel", async () => {
    await seedEvaluation({
      schoolId: school.id, classId: classe.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, teacherUserId: prof.id, date: daysFromNow(3),
    });

    await sendEvaluationReminders();
    const second = await sendEvaluationReminders();

    expect(second).toEqual({ sent: 0, failed: 0 });
    expect(await prisma.notification.count()).toBe(1);
  });

  it('compte en échec une classe sans aucun parent lié, sans bloquer les autres', async () => {
    const classeSansParent = await prisma.class.create({
      data: { schoolId: school.id, name: '5e A', level: '5e' },
    });
    // Pas de teacherUserId ici : prof n'est pas affecté à cette classe, la
    // notification retomberait sinon sur le refus d'autorisation de
    // `createNotification` plutôt que sur le cas qu'on veut isoler (aucun
    // parent lié) — l'admin, lui, n'a pas cette restriction.
    await seedEvaluation({
      schoolId: school.id, classId: classeSansParent.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, label: 'Sans parent', date: daysFromNow(3),
    });
    await seedEvaluation({
      schoolId: school.id, classId: classe.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, teacherUserId: prof.id, label: 'Avec parent', date: daysFromNow(3),
    });

    const result = await sendEvaluationReminders();

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(await prisma.notification.count()).toBe(1);
  });

  it("retombe sur un admin de l'école quand l'évaluation n'a pas de teacherUserId", async () => {
    await seedEvaluation({
      schoolId: school.id, classId: classe.id, subjectId: maths.id, gradeTypeId: devoirId,
      termId: term.id, teacherUserId: undefined, date: daysFromNow(3),
    });

    const result = await sendEvaluationReminders();

    expect(result).toEqual({ sent: 1, failed: 0 });
    const notification = await prisma.notification.findFirst({ where: { schoolId: school.id } });
    expect(notification?.creatorUserId).toBe(admin.id);
  });
});
