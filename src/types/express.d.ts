import type { Role } from '../generated/prisma/enums';

export interface AuthPayload {
  userId: number;
  schoolId: number;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      /** Présent uniquement si un JWT valide accompagne la requête. */
      auth?: AuthPayload;
      /** École résolue par le sous-domaine (disponible même sans token). */
      schoolId?: number;
    }
  }
}
