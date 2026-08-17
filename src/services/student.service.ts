import argon2 from 'argon2';
import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import type { AuthPayload } from '../types/express';
import type { Prisma } from '../generated/prisma/client';
import { badRequest, conflict, notFound } from '../errors/AppError';
import { computeStudentResult } from './grading/grading.service';
import { contactFields, identityFields } from './userFields';
import { labelKey, normalizeEmail, normalizePhone } from '../lib/normalize';
import { parseCsv, toCsv, type CsvCell } from '../lib/csv';
import { sendInvitation } from './invitation.service';

const RECENT_ATTENDANCE_LIMIT = 10;
const RECENT_GRADES_LIMIT = 10;

export const STUDENTS_PAGE_SIZE = 100;

/**
 * Restreint la lecture au périmètre de l'appelant.
 *
 * Un enseignant ne consulte que les élèves des classes où il enseigne : le
 * reste du code le borne partout ailleurs à ses affectations, il n'y a aucune
 * raison que l'annuaire des élèves fasse exception.
 */
async function scopeFor(auth: AuthPayload, classId?: number): Promise<Prisma.StudentWhereInput> {
  if (auth.role === 'admin') {
    return classId ? { classId } : {};
  }

  const assignments = await prisma.teacherAssignment.findMany({
    where: { schoolId: auth.schoolId, teacherUserId: auth.userId },
    select: { classId: true },
  });
  const classIds = [...new Set(assignments.map((a) => a.classId))];

  // Une classe demandée hors périmètre ne renvoie rien plutôt qu'une erreur :
  // l'enseignant n'a pas à découvrir quelles classes existent. `in: []` dit
  // « aucune » sans recourir à un identifiant sentinelle, qui ne tiendrait
  // qu'à une propriété de la séquence PostgreSQL.
  if (classId !== undefined) {
    return { classId: { in: classIds.includes(classId) ? [classId] : [] } };
  }
  return { classId: { in: classIds } };
}

/**
 * Les coordonnées des familles sont réservées à l'administration. Un
 * enseignant voit le nom des parents, pas leur email ni leur téléphone.
 */
const parentSelectFor = (auth: AuthPayload) =>
  auth.role === 'admin' ? contactFields : identityFields;

export async function listStudents(
  auth: AuthPayload,
  filters: { classId?: number; includeArchived?: boolean; page?: number; search?: string },
) {
  const page = Math.max(1, filters.page ?? 1);
  const search = filters.search?.trim();

  const where = {
    schoolId: auth.schoolId,
    ...(await scopeFor(auth, filters.classId)),
    ...(filters.includeArchived ? {} : { archivedAt: null }),
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, students] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      // Sans pagination, un établissement de 900 élèves construit plusieurs
      // mégaoctets de JSON à chaque ouverture de l'écran.
      skip: (page - 1) * STUDENTS_PAGE_SIZE,
      take: STUDENTS_PAGE_SIZE,
      include: {
        class: { select: { id: true, name: true, level: true } },
        parents: { include: { parent: { select: parentSelectFor(auth) } } },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize: STUDENTS_PAGE_SIZE,
    students: students.map(({ parents, class: klass, ...student }) => ({
      ...student,
      classe: klass,
      parents: parents.map((p) => p.parent),
    })),
  };
}

/**
 * Export tableur de l'annuaire, **sans pagination**.
 *
 * C'est la raison d'être de cet export : la liste à l'écran s'arrête à 100
 * élèves, et un secrétariat qui veut la liste de l'établissement ne va pas
 * recopier neuf pages. Le volume reste raisonnable — quelques centaines de
 * lignes de texte, sans commune mesure avec le JSON complet que la pagination
 * évitait.
 *
 * Le périmètre de l'appelant s'applique comme partout : un enseignant n'exporte
 * que ses classes.
 */
export async function exportStudentsCsv(
  auth: AuthPayload,
  filters: { classId?: number; includeArchived?: boolean },
): Promise<string> {
  const students = await prisma.student.findMany({
    where: {
      schoolId: auth.schoolId,
      ...(await scopeFor(auth, filters.classId)),
      ...(filters.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ class: { name: 'asc' } }, { lastName: 'asc' }, { firstName: 'asc' }],
    include: {
      class: { select: { name: true } },
      parents: { include: { parent: { select: parentSelectFor(auth) } } },
    },
  });

  const isAdmin = auth.role === 'admin';

  const header: CsvCell[] = [
    'Nom',
    'Prénom',
    'Classe',
    'Date de naissance',
    'Parents',
    // Les coordonnées des familles ne sortent pas pour un enseignant, comme
    // dans toutes les autres lectures.
    ...(isAdmin ? ['Contacts parents'] : []),
    'Statut',
  ];

  const rows: CsvCell[][] = students.map((student) => {
    const parents = student.parents.map((p) => p.parent);
    return [
      student.lastName,
      student.firstName,
      student.class.name,
      student.birthDate ? student.birthDate.toISOString().slice(0, 10) : '',
      parents
        .map((p) => [p.firstName, p.lastName].filter(Boolean).join(' ').trim())
        .filter(Boolean)
        .join(' / '),
      ...(isAdmin ? [parents.map(contactOf).filter(Boolean).join(' / ')] : []),
      student.archivedAt ? 'Archivé' : 'Inscrit',
    ];
  });

  return toCsv([header, ...rows]);
}

// ------------------------------------------------------ Import d'une liste

/** Ce qu'on a compris d'une ligne du fichier. */
export type ImportRow = {
  /** Numéro de ligne dans le fichier, en-tête comprise : c'est ce que voit l'utilisateur. */
  line: number;
  firstName: string;
  lastName: string;
  className: string;
  birthDate: string | null;
  /** `create` : sera inscrit. `duplicate`/`error` : ignoré, avec le motif. */
  status: 'create' | 'duplicate' | 'error';
  reason?: string;
};

export type ImportReport = {
  rows: ImportRow[];
  counts: { create: number; duplicate: number; error: number };
  /** Vrai si rien n'a été écrit : l'appelant n'a demandé qu'un aperçu. */
  dryRun: boolean;
};

const IMPORT_MAX_ROWS = 2000;

/**
 * En-têtes acceptées, par colonne. Les fichiers viennent de secrétariats
 * différents et personne ne les nommera à l'identique ; comparer sur une clé
 * insensible à la casse et aux accents évite de refuser « PRENOM » ou
 * « Classe  ».
 */
const COLUMN_ALIASES: Record<'lastName' | 'firstName' | 'className' | 'birthDate', string[]> = {
  lastName: ['nom', 'nom de famille', 'last name', 'lastname'],
  firstName: ['prenom', 'prenoms', 'first name', 'firstname'],
  className: ['classe', 'class', 'classe actuelle'],
  birthDate: ['date de naissance', 'naissance', 'birth date', 'birthdate', 'ne le', 'nee le'],
};

/**
 * Import d'une liste d'élèves depuis un CSV.
 *
 * Toujours en deux temps : `dryRun` rend le rapport ligne à ligne, l'appelant
 * le montre, puis rejoue avec `dryRun: false`. Une inscription de masse qu'on
 * ne peut pas relire avant de valider est une inscription qu'on passera la
 * journée à défaire.
 *
 * Aucune classe n'est créée implicitement : une classe inconnue est une faute
 * de frappe neuf fois sur dix, et en créer une silencieusement scinderait
 * l'effectif d'un niveau entre « 6e A » et « 6eA » sans que personne ne le voie.
 */
export async function importStudents(
  schoolId: number,
  csv: string,
  options: { dryRun: boolean },
): Promise<ImportReport> {
  const table = parseCsv(csv);
  const header = table[0];
  if (!header) throw badRequest('Ce fichier est vide.');

  const body = table.slice(1);
  const columns = mapColumns(header);

  if (body.length === 0) {
    throw badRequest(
      "Ce fichier ne contient aucun élève : il n'y a que la première ligne, celle des titres.",
    );
  }
  if (body.length > IMPORT_MAX_ROWS) {
    throw badRequest(
      `Ce fichier contient ${body.length} élèves. On peut en ajouter ${IMPORT_MAX_ROWS} à la fois : coupez-le en plusieurs fichiers, par exemple un par niveau.`,
      { max: IMPORT_MAX_ROWS },
    );
  }

  const classes = await prisma.class.findMany({
    where: { schoolId, archivedAt: null },
    select: { id: true, name: true },
  });
  const classByKey = new Map(classes.map((klass) => [labelKey(klass.name), klass.id]));

  const existing = await prisma.student.findMany({
    where: { schoolId },
    select: { firstName: true, lastName: true, classId: true },
  });
  // Les élèves archivés comptent comme doublons : réinscrire un homonyme
  // créerait une seconde scolarité au lieu de restaurer la première.
  const seen = new Set(existing.map((s) => studentKey(s.firstName, s.lastName, s.classId)));

  const rows: ImportRow[] = body.map((cells, index) =>
    readRow(cells, index + 2, columns, classByKey, seen),
  );

  const counts = {
    create: rows.filter((row) => row.status === 'create').length,
    duplicate: rows.filter((row) => row.status === 'duplicate').length,
    error: rows.filter((row) => row.status === 'error').length,
  };

  if (options.dryRun || counts.create === 0) {
    return { rows, counts, dryRun: true };
  }

  // Tout ou rien : un import à moitié appliqué laisse le secrétariat sans
  // moyen de savoir où il s'est arrêté.
  await prisma.$transaction(
    rows
      .filter((row) => row.status === 'create')
      .map((row) =>
        prisma.student.create({
          data: {
            schoolId,
            classId: classByKey.get(labelKey(row.className))!,
            firstName: row.firstName,
            lastName: row.lastName,
            birthDate: row.birthDate ? new Date(row.birthDate) : null,
          },
        }),
      ),
  );

  return { rows, counts, dryRun: false };
}

function studentKey(firstName: string, lastName: string, classId: number): string {
  return `${labelKey(lastName)}|${labelKey(firstName)}|${classId}`;
}

/** Position de chaque colonne dans l'en-tête, ou -1 si absente. */
function mapColumns(header: string[]): Record<keyof typeof COLUMN_ALIASES, number> {
  const keys = header.map((cell) => labelKey(cell));
  const find = (aliases: string[]) => keys.findIndex((key) => aliases.includes(key));

  const columns = {
    lastName: find(COLUMN_ALIASES.lastName),
    firstName: find(COLUMN_ALIASES.firstName),
    className: find(COLUMN_ALIASES.className),
    birthDate: find(COLUMN_ALIASES.birthDate),
  };

  const missing = (['lastName', 'firstName', 'className'] as const)
    .filter((key) => columns[key] === -1)
    .map((key) => ({ lastName: 'Nom', firstName: 'Prénom', className: 'Classe' })[key]);

  if (missing.length > 0) {
    // Message écrit pour un secrétariat, pas pour un développeur : on nomme ce
    // qui manque, on dit où le mettre, et on montre à quoi doit ressembler la
    // première ligne. « Colonne manquante dans l'en-tête » ne dit rien à qui
    // n'a jamais entendu le mot « en-tête ».
    const quoted = missing.map((name) => `« ${name} »`);
    const list =
      quoted.length === 1
        ? quoted[0]
        : `${quoted.slice(0, -1).join(', ')} et ${quoted[quoted.length - 1]}`;

    throw badRequest(
      `Il manque ${missing.length === 1 ? 'la colonne' : 'les colonnes'} ${list} dans votre fichier. ` +
        'Tout en haut, la première ligne doit donner le titre de chaque colonne, comme ceci : ' +
        "Nom ; Prénom ; Classe ; Date de naissance. La date de naissance n'est pas obligatoire.",
      { attendu: ['Nom', 'Prénom', 'Classe', 'Date de naissance'], manquant: missing },
    );
  }

  return columns;
}

/**
 * Analyse d'une ligne. Ne lève jamais : une ligne fautive devient une ligne en
 * erreur dans le rapport, pour que l'utilisateur les voie **toutes** d'un coup
 * plutôt que de corriger son fichier une faute à la fois.
 */
function readRow(
  cells: string[],
  line: number,
  columns: Record<keyof typeof COLUMN_ALIASES, number>,
  classByKey: Map<string, number>,
  seen: Set<string>,
): ImportRow {
  const at = (index: number) => (index === -1 ? '' : (cells[index] ?? '').trim());

  const lastName = at(columns.lastName);
  const firstName = at(columns.firstName);
  const className = at(columns.className);
  const rawBirth = at(columns.birthDate);

  const base = { line, firstName, lastName, className, birthDate: null as string | null };

  if (!lastName || !firstName) {
    return {
      ...base,
      status: 'error',
      reason: !lastName && !firstName
        ? 'Le nom et le prénom sont vides.'
        : `Le ${lastName ? 'prénom' : 'nom'} est vide.`,
    };
  }

  const classId = classByKey.get(labelKey(className));
  if (classId === undefined) {
    return {
      ...base,
      status: 'error',
      reason: className
        ? `La classe « ${className} » n'existe pas encore dans Gesnotes. Créez-la, ou corrigez son écriture dans le fichier.`
        : "La classe n'est pas indiquée.",
    };
  }

  const birthDate = rawBirth ? parseBirthDate(rawBirth) : null;
  if (rawBirth && birthDate === null) {
    return {
      ...base,
      status: 'error',
      reason: `Date de naissance incomprise : « ${rawBirth} ». Écrivez-la comme ceci : 12/03/2012.`,
    };
  }

  const key = studentKey(firstName, lastName, classId);
  if (seen.has(key)) {
    return {
      ...base,
      birthDate,
      status: 'duplicate',
      reason: 'Cet élève est déjà inscrit dans cette classe.',
    };
  }

  // Le fichier lui-même peut contenir deux fois la même ligne.
  seen.add(key);

  return { ...base, birthDate, status: 'create' };
}

/**
 * Date au format français ou ISO.
 *
 * Excel réécrit volontiers les dates selon la locale du poste : accepter les
 * deux évite de renvoyer le secrétariat reformater 300 cellules.
 */
function parseBirthDate(value: string): string | null {
  const french = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  const parts = french
    ? { year: french[3]!, month: french[2]!.padStart(2, '0'), day: french[1]!.padStart(2, '0') }
    : iso
      ? { year: iso[1]!, month: iso[2]!, day: iso[3]! }
      : null;

  if (!parts) return null;
  const { year, month, day } = parts;

  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Rejette le 31 février, que `Date` accepterait en glissant au 3 mars.
  if (date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return null;

  return `${year}-${month}-${day}`;
}

/**
 * Coordonnée affichable d'un parent. Le `select` varie selon le rôle
 * (`contactFields` ou `identityFields`) : la présence des champs se vérifie
 * donc à l'exécution, pas au type.
 */
function contactOf(parent: object): string {
  const email = 'email' in parent ? parent.email : null;
  const phone = 'phone' in parent ? parent.phone : null;
  return (typeof email === 'string' && email) || (typeof phone === 'string' && phone) || '';
}

export async function getStudent(auth: AuthPayload, id: number) {
  return loadStudent(auth.schoolId, id, parentSelectFor(auth), await scopeFor(auth));
}

/**
 * Fiche complète d'un élève : identité, classe, parents (déjà couverts par
 * `getStudent`, qui porte aussi le contrôle d'accès — un enseignant n'obtient
 * la suite que s'il a le droit de voir cet élève), moyennes par matière sur
 * la période choisie, présence et notes les plus récentes.
 *
 * `termId` omis : aucune période n'est encore ouverte, ou aucune n'est
 * sélectionnée côté client — le bulletin vaut alors `null` plutôt que
 * d'échouer, comme le reste du tableau de bord (`dashboard.service.ts`).
 *
 * Les notes/moyennes ne sont pas bornées aux matières de l'enseignant
 * appelant : `computeStudentResult` fait déjà de même pour le bulletin de
 * classe (`bulletin.service.ts`), accessible à qui peut voir la classe — la
 * fiche élève suit la même règle plutôt que d'en inventer une nouvelle.
 */
export async function getStudentDetail(auth: AuthPayload, id: number, termId?: number) {
  const identity = await getStudent(auth, id);

  const [bulletin, presence, recentGrades] = await Promise.all([
    termId !== undefined ? computeStudentResult(auth.schoolId, id, termId) : null,
    prisma.attendance.findMany({
      where: { studentId: id, schoolId: auth.schoolId },
      orderBy: { date: 'desc' },
      take: RECENT_ATTENDANCE_LIMIT,
      select: { id: true, date: true, status: true, comment: true },
    }),
    prisma.grade.findMany({
      where: { studentId: id, schoolId: auth.schoolId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_GRADES_LIMIT,
      select: {
        id: true,
        value: true,
        maxValue: true,
        createdAt: true,
        subject: { select: { id: true, name: true } },
        gradeType: { select: { label: true } },
        term: { select: { id: true, label: true } },
      },
    }),
  ]);

  return {
    ...identity,
    bulletin,
    presence,
    dernieresNotes: recentGrades.map((grade) => ({
      id: grade.id,
      value: Number(grade.value),
      maxValue: Number(grade.maxValue),
      createdAt: grade.createdAt,
      matiere: grade.subject,
      type: { label: grade.gradeType.label },
      periode: grade.term,
    })),
  };
}

/**
 * Lecture non restreinte, pour les opérations d'écriture réservées à
 * l'administration : la route porte déjà `requireRole('admin')`.
 */
function getStudentForAdmin(schoolId: number, id: number) {
  return loadStudent(schoolId, id, contactFields, {});
}

async function loadStudent(
  schoolId: number,
  id: number,
  parentSelect: typeof contactFields | typeof identityFields,
  // Typé, et non `Record<string, unknown>` : une faute de frappe dans le
  // filtre de périmètre compilerait, Prisma ignorerait la clé inconnue, et le
  // cloisonnement des enseignants disparaîtrait sans bruit.
  scope: Prisma.StudentWhereInput,
) {
  const student = await prisma.student.findFirst({
    where: { id, schoolId, ...scope },
    include: {
      class: { select: { id: true, name: true, level: true } },
      parents: { include: { parent: { select: parentSelect } } },
    },
  });
  if (!student) throw notFound('Élève introuvable');

  const { parents, class: klass, ...rest } = student;
  return { ...rest, classe: klass, parents: parents.map((p) => p.parent) };
}

export async function createStudent(
  schoolId: number,
  data: { firstName: string; lastName: string; classId: number; birthDate?: string },
) {
  await assertClassInSchool(schoolId, data.classId);

  const created = await prisma.student.create({
    data: {
      schoolId,
      classId: data.classId,
      firstName: data.firstName,
      lastName: data.lastName,
      birthDate: data.birthDate ? new Date(data.birthDate) : null,
    },
  });

  return getStudentForAdmin(schoolId, created.id);
}

export async function updateStudent(
  schoolId: number,
  id: number,
  data: { firstName?: string; lastName?: string; classId?: number; birthDate?: string | null },
) {
  await getStudentForAdmin(schoolId, id);
  if (data.classId !== undefined) await assertClassInSchool(schoolId, data.classId);

  await prisma.student.update({
    where: { id },
    data: {
      ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
      ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
      ...(data.classId !== undefined ? { classId: data.classId } : {}),
      ...(data.birthDate !== undefined
        ? { birthDate: data.birthDate ? new Date(data.birthDate) : null }
        : {}),
    },
  });

  return getStudentForAdmin(schoolId, id);
}

/**
 * Archivage : l'élève sort des listes, des classements et des moyennes, mais
 * ses notes et son historique restent consultables.
 */
export async function archiveStudent(schoolId: number, id: number) {
  await getStudentForAdmin(schoolId, id);
  await prisma.student.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function restoreStudent(schoolId: number, id: number) {
  await getStudentForAdmin(schoolId, id);
  await prisma.student.update({ where: { id }, data: { archivedAt: null } });
  return getStudentForAdmin(schoolId, id);
}

/**
 * Suppression définitive, en cascade sur les notes et les liens parents
 * (décision explicite du plan §1.4).
 *
 * `expectedName` est une confirmation obligatoire : l'opération efface la
 * scolarité complète d'un enfant et rien ne permet de revenir en arrière.
 * Exiger le nom exact évite le clic sur la mauvaise ligne d'un tableau.
 */
export async function deleteStudentPermanently(
  schoolId: number,
  id: number,
  expectedName: string,
) {
  const student = await getStudentForAdmin(schoolId, id);

  const actual = `${student.firstName} ${student.lastName}`.trim().toLowerCase();
  if (expectedName.trim().toLowerCase() !== actual) {
    throw badRequest(
      "La confirmation ne correspond pas au nom de l'élève. Cette suppression est définitive.",
      { attendu: `${student.firstName} ${student.lastName}` },
    );
  }

  await prisma.student.delete({ where: { id } });
}

/**
 * Recherche d'un compte parent existant, par nom, email ou téléphone.
 *
 * Strictement limitée à l'école : sans ce filtre, l'association d'un parent
 * deviendrait un annuaire de tous les utilisateurs de la plateforme.
 */
export async function searchParents(schoolId: number, query: string) {
  const term = query.trim();
  if (term.length < 2) return [];

  return prisma.user.findMany({
    where: {
      schoolId,
      role: 'parent',
      archivedAt: null,
      OR: [
        { email: { contains: normalizeEmail(term), mode: 'insensitive' } },
        { phone: { contains: normalizePhone(term) } },
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
      ],
    },
    orderBy: [{ lastName: 'asc' }, { email: 'asc' }],
    take: 20,
    select: contactFields,
  });
}

/**
 * Associe un parent à un élève : soit un compte existant (`parentUserId`),
 * soit un nouveau compte créé par invitation.
 *
 * Aucun mot de passe ne transite par l'API : le compte est créé avec un secret
 * aléatoire inutilisable et le parent reçoit un lien pour définir le sien.
 */
export async function attachParent(
  schoolId: number,
  studentId: number,
  input: {
    parentUserId?: number;
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
  },
) {
  await getStudentForAdmin(schoolId, studentId);

  const parent =
    input.parentUserId !== undefined
      ? await findExistingParent(schoolId, input.parentUserId)
      : await createParentAccount(schoolId, {
          email: input.email!,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
        });

  const already = await prisma.studentParent.findUnique({
    where: { studentId_parentUserId: { studentId, parentUserId: parent.id } },
  });
  if (already) throw conflict('Ce parent est déjà associé à cet élève.');

  await prisma.studentParent.create({ data: { schoolId, studentId, parentUserId: parent.id } });

  return getStudentForAdmin(schoolId, studentId);
}

export async function detachParent(schoolId: number, studentId: number, parentUserId: number) {
  await getStudentForAdmin(schoolId, studentId);

  const { count } = await prisma.studentParent.deleteMany({ where: { studentId, parentUserId } });
  if (count === 0) throw notFound("Ce parent n'est pas associé à cet élève.");

  return getStudentForAdmin(schoolId, studentId);
}

/**
 * Renvoie le lien d'invitation à un parent déjà associé (email perdu, lien
 * expiré). Émet un nouveau token à usage unique, comme la première invitation.
 */
export async function resendParentInvitation(
  schoolId: number,
  studentId: number,
  parentUserId: number,
) {
  await getStudentForAdmin(schoolId, studentId);

  const link = await prisma.studentParent.findUnique({
    where: { studentId_parentUserId: { studentId, parentUserId } },
  });
  if (!link) throw notFound("Ce parent n'est pas associé à cet élève.");

  const parent = await prisma.user.findFirst({
    where: { id: parentUserId, schoolId, role: 'parent', archivedAt: null },
    select: { id: true, email: true },
  });
  if (!parent) throw notFound("Ce compte parent n'existe pas dans cet établissement.");

  await sendInvitation(parent.id, parent.email, 'parent');
}

async function findExistingParent(schoolId: number, parentUserId: number) {
  const parent = await prisma.user.findFirst({
    where: { id: parentUserId, schoolId, role: 'parent', archivedAt: null },
    select: contactFields,
  });
  if (!parent) throw notFound("Ce compte parent n'existe pas dans cet établissement.");
  return parent;
}

async function createParentAccount(
  schoolId: number,
  input: { email: string; firstName?: string; lastName?: string; phone?: string },
) {
  const email = normalizeEmail(input.email);
  const phone = input.phone ? normalizePhone(input.phone) : null;

  const existing = await prisma.user.findFirst({ where: { schoolId, email } });
  if (existing) {
    // Cas courant : un enseignant dont l'enfant est scolarisé sur place.
    // Conseiller « associez le compte existant » sans donner son identifiant
    // laisserait l'administration bloquée sur une action irréalisable.
    if (existing.role !== 'parent') {
      throw conflict(
        `Cet email est déjà utilisé par un compte ${existing.role} de l'établissement. Utilisez une autre adresse pour le compte parent.`,
        { compteExistant: { id: existing.id, role: existing.role } },
      );
    }

    throw conflict(
      'Un compte parent utilise déjà cet email dans cette école. Associez-le plutôt que d\'en créer un second.',
      { compteExistant: { id: existing.id, role: existing.role }, parentUserId: existing.id },
    );
  }

  const parent = await prisma.user.create({
    data: {
      schoolId,
      email,
      phone,
      role: 'parent',
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      passwordHash: await argon2.hash(crypto.randomBytes(32).toString('hex')),
    },
    select: contactFields,
  });

  await sendInvitation(parent.id, parent.email, 'parent');

  return parent;
}

async function assertClassInSchool(schoolId: number, classId: number) {
  const klass = await prisma.class.findFirst({ where: { id: classId, schoolId } });
  if (!klass) throw notFound("Cette classe n'existe pas dans cet établissement.");
  // Un élève inscrit dans une classe archivée disparaîtrait des listes
  // courantes sans que personne ne le remarque.
  if (klass.archivedAt) {
    throw conflict(
      `« ${klass.name} » est archivée : restaurez-la avant d'y inscrire un élève.`,
      { classId },
    );
  }
}
