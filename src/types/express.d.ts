import type { Role } from '../generated/prisma/enums';

export interface AuthPayload {
  userId: number;
  schoolId: number;
  role: Role;
}

/** Compte de l'équipe Gesnotes — hors périmètre multi-écoles, voir StaffUser. */
export interface StaffAuthPayload {
  staffId: number;
}

declare global {
  namespace Express {
    interface Request {
      /** Présent uniquement si un JWT valide accompagne la requête. */
      auth?: AuthPayload;
      /** École résolue par le sous-domaine (disponible même sans token). */
      schoolId?: number;
      /** Présent uniquement sur les routes /staff, posé par `requireStaffAuth`. */
      staffAuth?: StaffAuthPayload;
    }
  }
}
