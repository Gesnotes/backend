import { EventEmitter } from 'node:events';

import { logger } from './logger';

export interface GradeEvent {
  gradeId: number;
  schoolId: number;
  studentId: number;
  subjectId: number;
  termId: number;
}

export interface AttendanceEvent {
  attendanceId: number;
  schoolId: number;
  studentId: number;
  classId: number;
  /** Créneau d'origine (mode `notes`), `null` pour une classe mode `presence`. */
  slotId: number | null;
  /** Toujours 'absent' ou 'late' : le 'present' ne notifie personne. */
  status: 'absent' | 'late';
}

interface Events {
  'grade.created': GradeEvent;
  'grade.updated': GradeEvent;
  'attendance.marked': AttendanceEvent;
}

const emitter = new EventEmitter();

/**
 * Bus d'événements interne.
 *
 * La saisie d'une note émet ici ; le lot 11 (notifications push) s'y abonne.
 * Le découplage n'est pas décoratif : un envoi FCM indisponible ne doit
 * jamais faire échouer ni ralentir l'enregistrement d'une note. Les
 * abonnés sont donc appelés hors du cycle requête/réponse, et leurs erreurs
 * sont tracées sans remonter à l'appelant.
 */
export function emitEvent<K extends keyof Events>(event: K, payload: Events[K]): void {
  setImmediate(() => {
    try {
      emitter.emit(event, payload);
    } catch (error) {
      logger.error({ err: error, event }, "Échec d'un abonné à l'événement");
    }
  });
}

export function onEvent<K extends keyof Events>(
  event: K,
  handler: (payload: Events[K]) => void | Promise<void>,
): void {
  emitter.on(event, (payload: Events[K]) => {
    Promise.resolve(handler(payload)).catch((error: unknown) => {
      logger.error({ err: error, event }, "Échec d'un abonné à l'événement");
    });
  });
}
