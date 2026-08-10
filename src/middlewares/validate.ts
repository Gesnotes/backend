import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

import { badRequest } from '../errors/AppError';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Nom lisible d'un champ, pour le message d'erreur.
 *
 * Les clés de l'API sont techniques (`classId`, `maxValue`, `confirm_label`) :
 * telles quelles dans un message, elles n'apprennent rien à une secrétaire qui
 * cherche quel champ de son formulaire est en cause. Un champ absent de cette
 * table est rendu tel quel — mieux vaut un nom technique qu'un message muet.
 */
const FIELD_LABELS: Record<string, string> = {
  identifier: 'Email ou téléphone',
  password: 'Mot de passe',
  newPassword: 'Nouveau mot de passe',
  token: 'Lien de connexion',
  email: 'Email',
  phone: 'Téléphone',
  firstName: 'Prénom',
  lastName: 'Nom',
  birthDate: 'Date de naissance',
  name: 'Nom',
  level: 'Niveau',
  label: 'Libellé',
  className: 'Classe',
  classId: 'Classe',
  class_id: 'Classe',
  subjectId: 'Matière',
  subject_id: 'Matière',
  studentId: 'Élève',
  student_id: 'Élève',
  teacherUserId: 'Enseignant',
  homeroomTeacherId: 'Enseignant référent',
  mode: 'Mode de la classe',
  status: 'Statut de présence',
  schoolYearId: 'Année scolaire',
  school_year_id: 'Année scolaire',
  promotesToId: 'Classe supérieure',
  subdomain: 'Sous-domaine',
  toClassId: 'Classe de destination',
  decision: 'Décision',
  termId: 'Période',
  term_id: 'Période',
  gradeTypeId: 'Type de note',
  grade_type_id: 'Type de note',
  evaluationId: 'Évaluation',
  evaluation_id: 'Évaluation',
  refreshToken: 'Session',
  deviceToken: 'Appareil',
  parentUserId: 'Parent',
  parentId: 'Parent',
  copyCoefficientsFromClassId: 'Classe modèle',
  confirm_label: 'Confirmation',
  value: 'Note',
  maxValue: 'Barème',
  coefficient: 'Coefficient',
  weight: 'Poids',
  passingGrade: 'Seuil de passage',
  comment: 'Commentaire',
  startDate: 'Date de début',
  endDate: 'Date de fin',
  date: 'Date',
  from: 'Date de début',
  to: 'Date de fin',
  until: 'Échéance',
  csv: 'Fichier',
  page: 'Page',
  assignments: 'Affectations',
  entries: 'Notes saisies',
  schoolName: "Nom de l'école",
  contactName: 'Votre nom',
  city: 'Ville',
  levels: 'Niveaux',
  q: 'Recherche',
};

function labelOf(field: string): string {
  return FIELD_LABELS[field] ?? `Champ « ${field} »`;
}

/**
 * Validation des entrées par Zod, en middleware.
 *
 * Les valeurs validées remplacent les valeurs brutes : le contrôleur reçoit
 * des données déjà coercées (nombres, dates) et typées.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const key of ['body', 'query', 'params'] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          champ: [key, ...issue.path].join('.'),
          message: issue.message,
        }));

        // Message affichable : on nomme le champ fautif et sa raison, au lieu
        // d'un « Données invalides » que l'utilisateur ne sait pas corriger.
        // Le détail complet reste dans `details` pour la mise en évidence.
        const first = result.error.issues[0];
        const field = first ? [...first.path].reverse().find((p) => typeof p === 'string') : undefined;
        const message = first
          ? typeof field === 'string'
            ? `${labelOf(field)} : ${first.message}`
            : first.message
          : 'Les informations envoyées ne sont pas valables.';

        return next(badRequest(message, details));
      }

      // req.query et req.params sont en lecture seule sur Express 5.
      // `configurable` est indispensable : sans lui, empiler deux `validate`
      // sur la même requête (routeur + route) lèverait « Cannot redefine
      // property ». `enumerable` garde la propriété visible des logs et de
      // tout code qui itère sur la requête.
      Object.defineProperty(req, key, {
        value: result.data,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    return next();
  };
}
