import prisma from '../lib/prisma';
import type { AuthPayload } from '../types/express';
import { conflict, forbidden, notFound } from '../errors/AppError';
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

export async function listClasses(schoolId: number, termId?: number, includeArchived = false) {
  const classes = await prisma.class.findMany({
    where: { schoolId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ level: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { students: { where: { archivedAt: null } } } } },
  });

  // Sans période, la moyenne n'a pas de sens : ne rien afficher plutôt que
  // d'agréger toutes les périodes confondues.
  if (termId === undefined) {
    return classes.map(({ _count, ...klass }) => ({
      ...klass,
      effectif: _count.students,
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

  return classes.map(({ _count, ...klass }) => ({
    ...klass,
    effectif: _count.students,
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

  return {
    ...bulletin,
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
 * Refuse un nom déjà porté par une autre classe de l'école.
 *
 * Comparaison insensible à la casse, aux accents et aux espaces : « 6e A » et
 * « 6E  A » désignent la même classe. Les classes archivées comptent, pour ne
 * pas recréer le doublon d'une classe simplement mise de côté.
 */
async function assertClassNameAvailable(schoolId: number, name: string, exceptId?: number) {
  const key = labelKey(name);
  const siblings = await prisma.class.findMany({
    where: { schoolId, ...(exceptId ? { id: { not: exceptId } } : {}) },
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

export async function createClass(
  schoolId: number,
  data: { name: string; level: string; copyCoefficientsFromClassId?: number },
) {
  data = { ...data, name: data.name.trim() };
  await assertClassNameAvailable(schoolId, data.name);

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
      data: { schoolId, name: data.name, level: data.level },
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
  data: { name?: string; level?: string },
) {
  await getClass(schoolId, id);
  const name = data.name?.trim();
  if (name !== undefined) await assertClassNameAvailable(schoolId, name, id);
  return prisma.class.update({ where: { id }, data: { ...data, ...(name ? { name } : {}) } });
}

/**
 * Archivage par défaut. La suppression définitive est refusée tant que la
 * classe contient des élèves : la cascade emporterait les élèves et donc
 * leurs notes.
 */
export async function deleteClass(schoolId: number, id: number, permanent: boolean) {
  await getClass(schoolId, id);

  if (!permanent) {
    return prisma.class.update({ where: { id }, data: { archivedAt: new Date() } });
  }

  const studentCount = await prisma.student.count({ where: { classId: id } });
  if (studentCount > 0) {
    throw conflict(
      `Suppression impossible : ${studentCount} élève(s) sont rattachés à cette classe. Archivez-la plutôt.`,
      { studentCount },
    );
  }

  return prisma.class.delete({ where: { id } });
}

export async function restoreClass(schoolId: number, id: number) {
  await getClass(schoolId, id);
  return prisma.class.update({ where: { id }, data: { archivedAt: null } });
}
