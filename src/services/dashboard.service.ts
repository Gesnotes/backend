import prisma from '../lib/prisma';
import { computeClassBulletins } from './grading/grading.service';
import { serializeAverage } from './grading/compute';
import { Prisma } from '../generated/prisma/client';

const JOURS_ACTIVITE = 7;

/**
 * Statistiques de l'établissement.
 *
 * Toutes les requêtes sont filtrées par `schoolId`, y compris les agrégats :
 * un dashboard qui compterait les élèves de toutes les écoles serait une fuite
 * silencieuse, invisible à la lecture du chiffre affiché.
 */
export async function getDashboard(schoolId: number, termId?: number) {
  const depuis = new Date();
  depuis.setDate(depuis.getDate() - JOURS_ACTIVITE);

  const [eleves, classes, enseignants, matieres, parents, notesRecentes, totalNotes] =
    await Promise.all([
      prisma.student.count({ where: { schoolId, archivedAt: null } }),
      prisma.class.count({ where: { schoolId, archivedAt: null } }),
      prisma.user.count({ where: { schoolId, role: 'teacher', archivedAt: null } }),
      prisma.subject.count({ where: { schoolId, archivedAt: null } }),
      prisma.user.count({ where: { schoolId, role: 'parent', archivedAt: null } }),
      prisma.grade.count({ where: { schoolId, createdAt: { gte: depuis } } }),
      prisma.grade.count({ where: { schoolId, ...(termId ? { termId } : {}) } }),
    ]);

  const effectifs = { eleves, classes, enseignants, matieres, parents };
  const activite = { notesDerniers7Jours: notesRecentes, notesTotal: totalNotes };

  /**
   * Forme de réponse unique quelle que soit la requête : toutes les clés sont
   * toujours présentes, à `null` ou vides. Faire disparaître `extremes` selon
   * les paramètres obligerait le front-end à tester son existence, et le ferait
   * planter le jour où il oublie.
   */
  const vide = {
    effectifs,
    activite,
    periode: null,
    moyenneEcole: null,
    classes: [],
    saisie: null,
    extremes: { meilleureClasse: null, plusFaibleClasse: null },
  };

  if (termId === undefined) return vide;

  const term = await prisma.term.findFirst({ where: { id: termId, schoolId } });
  if (!term) return vide;

  const classList = await prisma.class.findMany({
    where: { schoolId, archivedAt: null },
    orderBy: [{ level: 'asc' }, { name: 'asc' }],
    select: { id: true },
  });

  // Un seul lot de requêtes pour toutes les classes : en boucle, un
  // établissement de 30 classes paierait 90 requêtes à chaque chargement.
  const bulletins = await computeClassBulletins(
    schoolId,
    classList.map((klass) => klass.id),
    termId,
  );

  const parClasse = bulletins.map((bulletin) => ({
    classId: bulletin.classId,
    className: bulletin.className,
    level: bulletin.level,
    effectif: bulletin.students.length,
    evalues: bulletin.students.filter((s) => s.average !== null).length,
    average: bulletin.classAverage,
  }));

  // Moyenne de l'école : moyenne des moyennes d'élèves, pas moyenne des
  // moyennes de classes. Une classe de 10 élèves ne doit pas peser autant
  // qu'une classe de 40.
  const moyennesEleves = bulletins
    .flatMap((bulletin) => bulletin.students)
    .map((student) => student.average)
    .filter((average): average is number => average !== null);

  const moyenneEcole =
    moyennesEleves.length === 0
      ? null
      : serializeAverage(
          moyennesEleves
            .reduce((sum, v) => sum.add(new Prisma.Decimal(v)), new Prisma.Decimal(0))
            .div(moyennesEleves.length),
        );

  const totalEleves = parClasse.reduce((sum, c) => sum + c.effectif, 0);
  const totalEvalues = parClasse.reduce((sum, c) => sum + c.evalues, 0);

  // Le filtre garantit des moyennes non nulles : pas de valeur par défaut dans
  // le comparateur, qui laisserait croire qu'une classe non notée vaut 0.
  const triees = parClasse
    .filter((c): c is typeof c & { average: number } => c.average !== null)
    .sort((a, b) => b.average - a.average);

  return {
    effectifs,
    activite,
    periode: { id: term.id, label: term.label },
    moyenneEcole,
    classes: parClasse,
    // Avancement de la saisie : le chiffre qui dit à l'administration quelles
    // classes relancer avant la fin du trimestre.
    saisie: {
      elevesEvalues: totalEvalues,
      elevesTotal: totalEleves,
      taux: totalEleves === 0 ? null : Math.round((totalEvalues / totalEleves) * 100),
      classesSansAucuneNote: parClasse.filter((c) => c.evalues === 0).map((c) => c.className),
    },
    extremes: {
      meilleureClasse: triees[0] ?? null,
      plusFaibleClasse: triees[triees.length - 1] ?? null,
    },
  };
}

/** Flux d'activité : dernières notes saisies dans l'établissement. */
export async function getRecentGrades(schoolId: number, limit: number) {
  const grades = await prisma.grade.findMany({
    where: { schoolId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      student: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          class: { select: { id: true, name: true } },
        },
      },
      subject: { select: { id: true, name: true } },
      gradeType: { select: { label: true, weight: true } },
      teacher: { select: { id: true, firstName: true, lastName: true } },
      term: { select: { id: true, label: true } },
    },
  });

  return grades.map((grade) => ({
    id: grade.id,
    value: Number(grade.value),
    maxValue: Number(grade.maxValue),
    createdAt: grade.createdAt,
    eleve: {
      id: grade.student.id,
      firstName: grade.student.firstName,
      lastName: grade.student.lastName,
      classe: grade.student.class,
    },
    matiere: grade.subject,
    type: { label: grade.gradeType.label, weight: Number(grade.gradeType.weight) },
    // Nom seul : le flux d'activité n'a pas à diffuser les emails de l'équipe.
    professeur: grade.teacher
      ? { id: grade.teacher.id, firstName: grade.teacher.firstName, lastName: grade.teacher.lastName }
      : null,
    periode: grade.term,
  }));
}
