import prisma from '../lib/prisma';
import type { ClassMode } from '../generated/prisma/enums';
import type { AuthPayload } from '../types/express';
import { badRequest, conflict, forbidden, notFound } from '../errors/AppError';
import { labelKey } from '../lib/normalize';
import { computeClassBulletin, computeClassBulletins } from './grading/grading.service';

/**
 * Droit de consulter les résultats d'une classe.
 *
 * Une classe expose le classement nominatif de tous ses élèves : c'est la
 * donnée la plus sensible du produit. Le contrôle vit dans le service et non
 * dans les routes, pour qu'aucun point d'entrée ajouté plus tard ne puisse
 * l'oublier — le JSON et l'export PDF passent par la même porte.
 *
 * Un parent n'a jamais accès à cette vue : il consulte son enfant seul via
 * `/children/:id`.
 */
export async function assertCanViewClass(auth: AuthPayload, classId: number) {
  const klass = await prisma.class.findFirst({ where: { id: classId, schoolId: auth.schoolId } });
  if (!klass) throw notFound('Classe introuvable');

  if (auth.role === 'admin') return klass;

  if (auth.role === 'teacher') {
    const assignment = await prisma.teacherAssignment.findFirst({
      where: { teacherUserId: auth.userId, classId },
    });
    if (!assignment) throw forbidden("Vous n'enseignez pas dans cette classe.");
    return klass;
  }

  throw forbidden("Les résultats d'une classe sont réservés à l'équipe pédagogique.");
}

export async function listClasses(
  schoolId: number,
  termId?: number,
  includeArchived = false,
  schoolYearId?: number,
) {
  const classes = await prisma.class.findMany({
    where: {
      schoolId,
      ...(includeArchived ? {} : { archivedAt: null }),
      ...(schoolYearId !== undefined ? { schoolYearId } : {}),
    },
    orderBy: [{ level: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { students: { where: { archivedAt: null } } } } },
  });

  // Sans période, ni la moyenne ni le taux de saisie n'ont de sens : ne rien
  // afficher plutôt que d'agréger toutes les périodes confondues.
  if (termId === undefined) {
    return classes.map(({ _count, ...klass }) => ({
      ...klass,
      effectif: _count.students,
      evalues: null,
      average: null,
    }));
  }

  // Un seul lot pour toutes les classes : en boucle, cet écran de liste
  // paierait cinq requêtes par classe.
  const bulletins = await computeClassBulletins(
    schoolId,
    classes.map((klass) => klass.id),
    termId,
  );
  const moyenneParClasse = new Map(bulletins.map((b) => [b.classId, b.classAverage]));
  // Élève « évalué » : au moins une moyenne générale publiée sur la période —
  // le même critère que le tableau de bord, pas un simple compte de notes.
  const evaluesParClasse = new Map(
    bulletins.map((b) => [b.classId, b.students.filter((s) => s.average !== null).length]),
  );

  return classes.map(({ _count, ...klass }) => ({
    ...klass,
    effectif: _count.students,
    evalues: evaluesParClasse.get(klass.id) ?? 0,
    average: moyenneParClasse.get(klass.id) ?? null,
  }));
}

export async function getClass(schoolId: number, id: number) {
  const klass = await prisma.class.findFirst({ where: { id, schoolId } });
  if (!klass) throw notFound('Classe introuvable');
  return klass;
}

/**
 * Détail d'une classe : élèves classés par moyenne décroissante, plus les
 * extrêmes. Les élèves sans note gardent `average: null` et sont rejetés en
 * fin de classement — un élève non évalué n'est pas dernier de la classe.
 */
export async function getClassDetail(auth: AuthPayload, id: number, termId: number) {
  await assertCanViewClass(auth, id);

  const bulletin = await computeClassBulletin(auth.schoolId, id, termId);

  const ranked = [...bulletin.students].sort((a, b) => {
    if (a.average === null && b.average === null) {
      return a.lastName.localeCompare(b.lastName, 'fr');
    }
    if (a.average === null) return 1;
    if (b.average === null) return -1;
    return b.average - a.average;
  });

  const noted = ranked.filter((s) => s.average !== null);

  // `studentRawAverages` est un détail interne au calcul (pleine précision,
  // réservé au tableau de bord) : jamais renvoyé tel quel dans une réponse.
  const { studentRawAverages: _studentRawAverages, ...bulletinPublic } = bulletin;

  return {
    ...bulletinPublic,
    students: ranked.map((student, index) => ({
      ...student,
      rang: student.average === null ? null : index + 1,
    })),
    stats: {
      effectif: bulletin.students.length,
      evalues: noted.length,
      average: bulletin.classAverage,
      meilleure: noted[0]?.average ?? null,
      plusFaible: noted[noted.length - 1]?.average ?? null,
    },
  };
}

/**
 * Crée une classe. `copyCoefficientsFromClassId` reprend les coefficients
 * d'une classe existante : c'est le rôle du niveau comme gabarit (plan §2.4),
 * créer une 6e B en copiant la 6e A plutôt que de tout ressaisir.
 */
/**
 * Refuse un nom déjà porté par une autre classe de la même année scolaire (ou,
 * pour les classes sans année, une autre classe elle aussi sans année — le
 * comportement d'avant l'introduction des années scolaires, inchangé).
 *
 * Comparaison insensible à la casse, aux accents et aux espaces : « 6e A » et
 * « 6E  A » désignent la même classe. Les classes archivées comptent, pour ne
 * pas recréer le doublon d'une classe simplement mise de côté. Sans ce
 * cloisonnement par année, une « 6e A » ne pourrait jamais revenir d'une
 * rentrée à l'autre.
 */
async function assertClassNameAvailable(
  schoolId: number,
  name: string,
  schoolYearId: number | null,
  exceptId?: number,
) {
  const key = labelKey(name);
  const siblings = await prisma.class.findMany({
    where: { schoolId, schoolYearId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true, archivedAt: true },
  });

  const clash = siblings.find((klass) => labelKey(klass.name) === key);
  if (clash) {
    throw conflict(
      clash.archivedAt
        ? `Une classe archivée porte déjà ce nom (« ${clash.name} »). Restaurez-la plutôt.`
        : `La classe « ${clash.name} » existe déjà.`,
      { classId: clash.id, archived: clash.archivedAt !== null },
    );
  }
}

/** Vérifie que l'année scolaire proposée existe bien dans l'école appelante. */
async function assertSchoolYearValid(schoolId: number, schoolYearId: number) {
  const year = await prisma.schoolYear.findFirst({ where: { id: schoolYearId, schoolId } });
  if (!year) throw notFound('Année scolaire introuvable');
}

/**
 * Vérifie que la classe supérieure proposée existe dans la même école et
 * n'est pas la classe elle-même — une classe ne peut pas se promouvoir vers
 * elle-même.
 */
async function assertPromotesToValid(schoolId: number, classId: number, promotesToId: number) {
  if (promotesToId === classId) {
    throw badRequest('Une classe ne peut pas être sa propre classe supérieure.');
  }
  const target = await prisma.class.findFirst({ where: { id: promotesToId, schoolId } });
  if (!target) throw notFound('Classe supérieure introuvable');
}

/**
 * Vérifie que le référent proposé est bien un enseignant de l'école, en
 * activité. L'admin n'a pas besoin de figurer ici : il saisit déjà sans
 * restriction (plan maternelle/garderie).
 */
async function assertHomeroomTeacherValid(schoolId: number, homeroomTeacherId: number) {
  const teacher = await prisma.user.findFirst({
    where: { id: homeroomTeacherId, schoolId, role: 'teacher', archivedAt: null },
  });
  if (!teacher) throw notFound('Enseignant référent introuvable');
}

/**
 * Passer une classe en mode présence alors qu'elle porte déjà des évaluations
 * la laisserait dans un état incohérent avec le garde-fou symétrique de
 * `createEvaluation` (une classe présence ne peut plus en recevoir de
 * nouvelles). Refusé plutôt que de laisser les évaluations existantes orphelines
 * d'un mode qui ne les autorise plus.
 */
async function assertModeSwitchAllowed(classId: number, nextMode: ClassMode) {
  if (nextMode !== 'presence') return;

  const evaluationCount = await prisma.evaluation.count({ where: { classId } });
  if (evaluationCount > 0) {
    throw conflict(
      `Passage en mode présence impossible : ${evaluationCount} évaluation(s) existent déjà sur cette classe.`,
      { evaluationCount },
    );
  }
}

export async function createClass(
  schoolId: number,
  data: {
    name: string;
    level: string;
    mode?: ClassMode;
    homeroomTeacherId?: number;
    schoolYearId?: number;
    copyCoefficientsFromClassId?: number;
  },
) {
  data = { ...data, name: data.name.trim() };

  if (data.schoolYearId !== undefined) await assertSchoolYearValid(schoolId, data.schoolYearId);
  await assertClassNameAvailable(schoolId, data.name, data.schoolYearId ?? null);

  if (data.homeroomTeacherId !== undefined) {
    await assertHomeroomTeacherValid(schoolId, data.homeroomTeacherId);
  }

  const source = data.copyCoefficientsFromClassId
    ? await prisma.class.findFirst({
        where: { id: data.copyCoefficientsFromClassId, schoolId },
        include: { coefficients: true },
      })
    : null;

  if (data.copyCoefficientsFromClassId && !source) {
    throw notFound('Classe modèle introuvable');
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.class.create({
      data: {
        schoolId,
        name: data.name,
        level: data.level,
        mode: data.mode ?? 'notes',
        homeroomTeacherId: data.homeroomTeacherId ?? null,
        schoolYearId: data.schoolYearId ?? null,
      },
    });

    if (source?.coefficients.length) {
      await tx.subjectCoefficient.createMany({
        data: source.coefficients.map((c) => ({
          subjectId: c.subjectId,
          classId: created.id,
          coefficient: c.coefficient,
        })),
      });
    }

    return created;
  });
}

export async function updateClass(
  schoolId: number,
  id: number,
  data: {
    name?: string;
    level?: string;
    mode?: ClassMode;
    homeroomTeacherId?: number | null;
    schoolYearId?: number | null;
    promotesToId?: number | null;
  },
) {
  const existing = await getClass(schoolId, id);
  const name = data.name?.trim();

  if (data.schoolYearId !== undefined && data.schoolYearId !== null) {
    await assertSchoolYearValid(schoolId, data.schoolYearId);
  }
  // Le nom n'est unique que dans son année : revérifier dès que l'un des deux
  // change, pas seulement le nom seul.
  if (name !== undefined || data.schoolYearId !== undefined) {
    const effectiveYearId = data.schoolYearId !== undefined ? data.schoolYearId : existing.schoolYearId;
    await assertClassNameAvailable(schoolId, name ?? existing.name, effectiveYearId, id);
  }
  if (data.homeroomTeacherId !== undefined && data.homeroomTeacherId !== null) {
    await assertHomeroomTeacherValid(schoolId, data.homeroomTeacherId);
  }
  if (data.mode !== undefined) await assertModeSwitchAllowed(id, data.mode);
  if (data.promotesToId !== undefined && data.promotesToId !== null) {
    await assertPromotesToValid(schoolId, id, data.promotesToId);
  }

  return prisma.class.update({ where: { id }, data: { ...data, ...(name ? { name } : {}) } });
}

/**
 * Duplique une classe pour l'année scolaire suivante : nouvelle classe dans
 * l'année cible, reprenant le mode, le référent et les coefficients de la
 * source ; celle-ci pointe ensuite vers la nouvelle classe comme classe
 * supérieure. Sert de base au futur assistant de réinscription (lot 4), qui
 * s'appuiera sur `promotesToId` pour proposer où faire passer chaque élève.
 */
export async function duplicateClassForNextYear(
  schoolId: number,
  id: number,
  data: { schoolYearId: number; name?: string; level?: string },
) {
  const source = await getClass(schoolId, id);

  if (source.promotesToId) {
    throw conflict(
      'Cette classe a déjà été dupliquée pour une année suivante. Modifiez cette classe supérieure directement plutôt que d’en créer une autre.',
      { promotesToId: source.promotesToId },
    );
  }

  await assertSchoolYearValid(schoolId, data.schoolYearId);

  const name = (data.name ?? source.name).trim();
  const level = data.level ?? source.level;
  await assertClassNameAvailable(schoolId, name, data.schoolYearId);

  const coefficients = await prisma.subjectCoefficient.findMany({ where: { classId: id } });

  return prisma.$transaction(async (tx) => {
    const next = await tx.class.create({
      data: {
        schoolId,
        name,
        level,
        mode: source.mode,
        homeroomTeacherId: source.homeroomTeacherId,
        schoolYearId: data.schoolYearId,
      },
    });

    if (coefficients.length) {
      await tx.subjectCoefficient.createMany({
        data: coefficients.map((c) => ({
          subjectId: c.subjectId,
          classId: next.id,
          coefficient: c.coefficient,
        })),
      });
    }

    await tx.class.update({ where: { id }, data: { promotesToId: next.id } });

    return next;
  });
}

/**
 * Archivage par défaut. La suppression définitive est réservée à une classe
 * déjà archivée, avec retapage du nom exact — même garde-fou que pour une
 * période ou une année scolaire (voir `term.service.ts`). Elle emporte en
 * cascade tout ce qui s'y rattache : élèves (et donc leurs notes, présences
 * et liens parents, cascade déjà portée par `Student`), évaluations, notes,
 * affectations d'enseignants, coefficients, présences et historique de
 * réinscription. `promotesToId` est détaché (mis à `null`) sur les classes
 * qui désignaient celle-ci comme classe supérieure plutôt que d'être emporté
 * : ce sont des classes indépendantes, pas des données de celle-ci.
 */
export async function deleteClass(
  schoolId: number,
  id: number,
  permanent: boolean,
  expectedName = '',
) {
  const klass = await getClass(schoolId, id);

  if (!permanent) {
    return prisma.class.update({ where: { id }, data: { archivedAt: new Date() } });
  }

  if (!klass.archivedAt) {
    throw conflict('Archivez la classe avant de la supprimer définitivement.', { classId: id });
  }

  if (expectedName.trim().toLowerCase() !== klass.name.trim().toLowerCase()) {
    throw badRequest(
      'La confirmation ne correspond pas au nom de la classe. Cette suppression est définitive.',
      { attendu: klass.name },
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.class.updateMany({ where: { promotesToId: id }, data: { promotesToId: null } });
    return tx.class.delete({ where: { id } });
  });
}

export async function restoreClass(schoolId: number, id: number) {
  await getClass(schoolId, id);
  return prisma.class.update({ where: { id }, data: { archivedAt: null } });
}
