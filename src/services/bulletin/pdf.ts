import PDFDocument from 'pdfkit';

import type { AnnualStudentResult, StudentResult } from '../grading/grading.service';

/**
 * Génération des bulletins en PDF.
 *
 * Le bulletin est la pièce que les parents contestent : il doit être
 * **auditable**. Chaque moyenne de matière est accompagnée du détail par
 * catégorie de note et du coefficient appliqué, pour qu'un parent puisse
 * refaire le calcul à la main.
 */

/** Une colonne du tableau de détail — un type de note actif de l'école, dans l'ordre de sa position. */
export interface GradeTypeColumn {
  id: number;
  label: string;
}

export interface BulletinContext {
  schoolName: string;
  className: string;
  level: string;
  termLabel: string;
  /** "2025-2026" — absente si la période n'est rattachée à aucune année scolaire. */
  schoolYearLabel?: string | null;
  /** Effectif de la classe sur la période (élèves actifs, non archivés). */
  effectif?: number;
  classAverage: number | null;
  /** Plus forte / plus faible moyenne générale de la classe sur la période. */
  classHighestAverage?: number | null;
  classLowestAverage?: number | null;
  /** Image (PNG/JPEG) affichée à la place du nom de l'école, telle que réglée dans Paramètres. */
  bulletinHeaderImage?: Buffer | null;
  /** Image (PNG/JPEG) affichée en pied de page, au-dessus de la mention générique. */
  bulletinFooterImage?: Buffer | null;
}

/** Un `StudentResult`, enrichi des deux informations propres au bulletin imprimé (pas au calcul). */
export interface BulletinStudentRow extends StudentResult {
  repeating: boolean;
  rank: { position: number; total: number } | null;
}

const SEX_LABEL: Record<'M' | 'F', string> = { M: 'Masculin', F: 'Féminin' };

const MARGIN = 36;
const COLORS = {
  text: '#111827',
  muted: '#6b7280',
  line: '#d1d5db',
  band: '#f3f4f6',
};

function render(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** Hauteur maximale réservée à l'image d'en-tête : assez pour un bandeau, pas toute la page. */
const HEADER_IMAGE_MAX_HEIGHT = 70;
const FOOTER_IMAGE_MAX_HEIGHT = 45;

function header(doc: PDFKit.PDFDocument, context: BulletinContext, title: string) {
  const width = doc.page.width - MARGIN * 2;

  if (context.bulletinHeaderImage) {
    // L'image remplace le nom de l'école : une école qui en téléverse une a
    // déjà son nom (et souvent son logo, un cachet officiel) dedans.
    doc.image(context.bulletinHeaderImage, { fit: [width, HEADER_IMAGE_MAX_HEIGHT] });
    doc.moveDown(0.4);
  } else {
    doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.text).text(context.schoolName);
  }

  doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted);
  doc.text(`${title} — ${context.className} (${context.level}) — ${context.termLabel}`);
  doc.moveDown(0.8);
}

const GENERIC_FOOTER_LINE =
  'Gesnotes. Moyennes calculées à la volée, jamais stockées.';

/**
 * Pied de page : l'image propre à l'école (réglée dans Paramètres), s'il y en
 * a une, puis toujours la mention générique en dessous — jamais l'une à la
 * place de l'autre, la mention technique reste utile même personnalisée.
 */
function footer(doc: PDFKit.PDFDocument, context: BulletinContext) {
  const width = doc.page.width - MARGIN * 2;
  const genericLine = `Généré le ${new Date().toLocaleDateString('fr-FR')} — ${GENERIC_FOOTER_LINE}`;

  const genericY = doc.page.height - MARGIN - 10;

  if (context.bulletinFooterImage) {
    doc.image(context.bulletinFooterImage, MARGIN, genericY - FOOTER_IMAGE_MAX_HEIGHT - 4, {
      fit: [width, FOOTER_IMAGE_MAX_HEIGHT],
      align: 'center',
    });
  }

  doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted);
  doc.text(genericLine, MARGIN, genericY, { width, align: 'center' });
}

/**
 * Bloc d'identification en tête de page : nom, classe, effectif, année
 * scolaire, trimestre, sexe et redoublement — les informations qu'un
 * établissement attend en haut d'un bulletin imprimé, avant le tableau des
 * notes. `label` vide affiche « — » plutôt qu'un champ vide muet.
 */
function studentInfoBlock(
  doc: PDFKit.PDFDocument,
  context: BulletinContext,
  row: BulletinStudentRow,
  left: number,
  width: number,
): number {
  let y = doc.y + 4;

  doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.text);
  doc.text(`${row.lastName.toUpperCase()} ${row.firstName}`, left, y, { width });
  y = doc.y + 6;

  const col1 = left;
  const col2 = left + width / 2;
  const colWidth = width / 2 - 8;

  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
  const fields: [string, string][] = [
    [`Classe : ${context.className} (${context.level})`, `Année scolaire : ${context.schoolYearLabel ?? '—'}`],
    [`Effectif : ${context.effectif ?? '—'}`, `Trimestre : ${context.termLabel}`],
    [`Sexe : ${row.sex ? SEX_LABEL[row.sex] : '—'}`, `Redoublant : ${row.repeating ? 'Oui' : 'Non'}`],
  ];
  for (const [left1, right1] of fields) {
    doc.text(left1, col1, y, { width: colWidth });
    doc.text(right1, col2, y, { width: colWidth });
    y += 14;
  }

  return y + 4;
}

/** "1er" pour le premier, "2ème", "3ème"… ensuite — convention déjà vue sur les bulletins papier. */
function ordinal(position: number): string {
  return position === 1 ? '1er' : `${position}ème`;
}

/** Largeur minimale d'une colonne de catégorie : en dessous, un libellé comme « Composition » ne tient plus. */
const MIN_CATEGORY_COL_WIDTH = 42;

/**
 * Format « une page par élève » : le document remis à la famille.
 *
 * `gradeTypeColumns` porte les types de note actifs de l'école, dans l'ordre
 * de leur position — plus 3 colonnes fixes : le nombre de colonnes du
 * tableau de détail varie donc d'une école à l'autre (et change si
 * l'administration ajoute ou archive un type), leur largeur s'ajuste en
 * conséquence pour toujours tenir sur la largeur de page.
 */
export function generateStudentBulletinPdf(
  context: BulletinContext,
  students: BulletinStudentRow[],
  gradeTypeColumns: GradeTypeColumn[],
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN });

  students.forEach((student, index) => {
    if (index > 0) doc.addPage();

    header(doc, context, 'Bulletin scolaire');

    const left = MARGIN;
    const width = doc.page.width - MARGIN * 2;

    // Une colonne par type de note actif de l'école, jamais une par
    // évaluation — le nombre d'évaluations varie d'une matière à l'autre, le
    // nombre de types actifs non (il ne change qu'à la configuration).
    const fixedWidths = { subject: 128, coef: 34, average: 60 };
    const categoryWidth = Math.max(
      MIN_CATEGORY_COL_WIDTH,
      Math.floor(
        (width - fixedWidths.subject - fixedWidths.coef - fixedWidths.average) /
          Math.max(gradeTypeColumns.length, 1),
      ),
    );
    const colWidths = { ...fixedWidths, category: categoryWidth };
    const columns = {
      subject: left,
      coefficient: left + colWidths.subject,
      categories: gradeTypeColumns.map((_, i) => {
        const before = left + colWidths.subject + colWidths.coef;
        return before + i * colWidths.category;
      }),
      average: left + colWidths.subject + colWidths.coef + colWidths.category * gradeTypeColumns.length,
    };
    const averageWidth = left + width - columns.average;

    let y = studentInfoBlock(doc, context, student, left, width);

    // En-tête du tableau
    doc.rect(left, y - 3, width, 18).fill(COLORS.band);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.text);
    doc.text('Matière', columns.subject + 4, y, { width: colWidths.subject - 4 });
    doc.text('Coef.', columns.coefficient, y, { width: colWidths.coef, align: 'right' });
    gradeTypeColumns.forEach((gradeType, i) => {
      doc.text(gradeType.label, columns.categories[i]!, y, { width: colWidths.category, align: 'center' });
    });
    doc.text('Moyenne', columns.average, y, { width: averageWidth, align: 'right' });
    y += 20;

    doc.font('Helvetica').fontSize(9);

    for (const subject of student.subjects) {
      if (y > doc.page.height - MARGIN - 90) {
        doc.addPage();
        header(doc, context, 'Bulletin scolaire');
        y = studentInfoBlock(doc, context, student, left, width);
      }

      doc.fillColor(COLORS.text);
      doc.text(subject.subjectName, columns.subject + 4, y, { width: colWidths.subject - 4 });
      doc.text(String(subject.coefficient), columns.coefficient, y, {
        width: colWidths.coef,
        align: 'right',
      });

      gradeTypeColumns.forEach((gradeType, i) => {
        const found = subject.categories.find((c) => c.gradeTypeId === gradeType.id);
        doc.text(format(found?.average ?? null), columns.categories[i]!, y, {
          width: colWidths.category,
          align: 'center',
        });
      });

      doc.font('Helvetica-Bold').text(format(subject.average), columns.average, y, {
        width: averageWidth,
        align: 'right',
      });
      doc.font('Helvetica');

      y += 18;
      doc.moveTo(left, y - 4).lineTo(left + width, y - 4).strokeColor(COLORS.line).lineWidth(0.5).stroke();
    }

    // Synthèse
    y += 8;
    doc.rect(left, y - 4, width, 22).fill(COLORS.band);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text);
    doc.text('Moyenne générale', columns.subject + 4, y + 2, { width: 200 });
    doc.text(format(student.average), columns.average, y + 2, { width: averageWidth, align: 'right' });

    y += 26;
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
    const rankText = student.rank
      ? `Rang : ${ordinal(student.rank.position)} / ${student.rank.total}`
      : 'Rang : —';
    doc.text(rankText, columns.subject + 4, y, { width: width / 2 - 8 });
    doc.text(`Moyenne de la classe : ${format(context.classAverage)}`, left + width / 2, y, {
      width: width / 2,
    });
    y += 14;
    doc.text(
      `Plus forte moyenne de la classe : ${format(context.classHighestAverage ?? null)}`,
      columns.subject + 4,
      y,
      { width: width / 2 - 8 },
    );
    doc.text(
      `Plus faible moyenne de la classe : ${format(context.classLowestAverage ?? null)}`,
      left + width / 2,
      y,
      { width: width / 2 },
    );
    y += 18;

    if (student.average === null) {
      doc.fillColor(COLORS.muted).fontSize(8);
      doc.text(
        "Aucune note n'a encore été saisie pour cet élève sur cette période. L'absence de moyenne ne vaut pas zéro.",
        columns.subject + 4,
        y,
        { width: width - 8 },
      );
    }

    footer(doc, context);
  });

  if (students.length === 0) {
    header(doc, context, 'Bulletin scolaire');
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted);
    doc.text('Aucun élève dans cette classe.');
    footer(doc, context);
  }

  return render(doc);
}

/** Format « tableau de classe » : la vue de synthèse pour l'administration. */
export function generateClassBulletinPdf(
  context: BulletinContext,
  students: StudentResult[],
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN });

  header(doc, context, 'Tableau des moyennes');

  // Colonnes = matières notées dans la classe, dans l'ordre du premier élève.
  const subjects = students[0]?.subjects.map((s) => ({ id: s.subjectId, name: s.subjectName })) ?? [];

  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  const nameWidth = 150;
  const availableWidth = width - nameWidth - 60;
  const columnWidth = subjects.length > 0 ? availableWidth / subjects.length : availableWidth;

  /**
   * En-tête de colonnes, redessiné à chaque page.
   *
   * Sans cela, une classe de plus de ~35 élèves produit des pages de chiffres
   * sans titre : impossible de savoir à quelle matière correspond chaque
   * colonne sur le document imprimé.
   */
  const drawColumnHeader = (top: number): number => {
    doc.rect(left, top - 3, width, 18).fill(COLORS.band);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.text);
    doc.text('Élève', left + 4, top, { width: nameWidth });
    subjects.forEach((subject, index) => {
      doc.text(subject.name, left + nameWidth + index * columnWidth, top, {
        width: columnWidth,
        align: 'center',
        ellipsis: true,
      });
    });
    doc.text('Moy.', left + nameWidth + subjects.length * columnWidth, top, {
      width: 56,
      align: 'right',
    });
    doc.font('Helvetica').fontSize(8);
    return top + 20;
  };

  let y = drawColumnHeader(doc.y + 4);

  for (const student of students) {
    if (y > doc.page.height - MARGIN - 40) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN });
      header(doc, context, 'Tableau des moyennes');
      y = drawColumnHeader(doc.y + 4);
    }

    doc.fillColor(COLORS.text);
    doc.text(`${student.lastName.toUpperCase()} ${student.firstName}`, left + 4, y, {
      width: nameWidth,
      ellipsis: true,
    });

    subjects.forEach((subject, index) => {
      const found = student.subjects.find((s) => s.subjectId === subject.id);
      doc.text(format(found?.average ?? null), left + nameWidth + index * columnWidth, y, {
        width: columnWidth,
        align: 'center',
      });
    });

    doc.font('Helvetica-Bold');
    doc.text(format(student.average), left + nameWidth + subjects.length * columnWidth, y, {
      width: 56,
      align: 'right',
    });
    doc.font('Helvetica');

    y += 16;
    doc.moveTo(left, y - 4).lineTo(left + width, y - 4).strokeColor(COLORS.line).lineWidth(0.5).stroke();
  }

  y += 6;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.text);
  doc.text(`Moyenne de la classe : ${format(context.classAverage)}`, left + 4, y);

  footer(doc, context);

  return render(doc);
}

/**
 * Bulletin annuel, une page par élève : la progression période par période,
 * puis la moyenne annuelle — pas de détail par matière ici, `context.termLabel`
 * porte le libellé de l'année scolaire (« 2025-2026 ») plutôt qu'une période.
 */
export function generateAnnualStudentBulletinPdf(
  context: BulletinContext,
  terms: { label: string }[],
  students: AnnualStudentResult[],
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN });

  students.forEach((student, index) => {
    if (index > 0) doc.addPage();

    header(doc, context, 'Bulletin annuel');

    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.text);
    doc.text(`${student.lastName.toUpperCase()} ${student.firstName}`);
    doc.moveDown(0.5);

    const left = MARGIN;
    const width = doc.page.width - MARGIN * 2;
    const columns = { period: left, average: left + width - 100 };

    let y = doc.y + 4;
    doc.rect(left, y - 3, width, 18).fill(COLORS.band);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.text);
    doc.text('Période', columns.period + 4, y, { width: 300 });
    doc.text('Moyenne', columns.average, y, { width: 96, align: 'right' });
    y += 20;

    doc.font('Helvetica').fontSize(9);

    terms.forEach((term, i) => {
      doc.fillColor(COLORS.text);
      doc.text(term.label, columns.period + 4, y, { width: 300 });
      doc.font('Helvetica-Bold').text(format(student.termAverages[i] ?? null), columns.average, y, {
        width: 96,
        align: 'right',
      });
      doc.font('Helvetica');

      y += 18;
      doc.moveTo(left, y - 4).lineTo(left + width, y - 4).strokeColor(COLORS.line).lineWidth(0.5).stroke();
    });

    y += 8;
    doc.rect(left, y - 4, width, 22).fill(COLORS.band);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text);
    doc.text('Moyenne annuelle', columns.period + 4, y + 2, { width: 300 });
    doc.text(format(student.average), columns.average, y + 2, { width: 96, align: 'right' });

    y += 26;
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
    doc.text(`Moyenne annuelle de la classe : ${format(context.classAverage)}`, columns.period + 4, y);

    if (student.average === null) {
      doc.moveDown(0.6);
      doc.fillColor(COLORS.muted).fontSize(8);
      doc.text(
        "Aucune moyenne n'a pu être calculée pour cet élève sur l'année. L'absence de moyenne ne vaut pas zéro.",
        { width: width - 8 },
      );
    }

    footer(doc, context);
  });

  if (students.length === 0) {
    header(doc, context, 'Bulletin annuel');
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted);
    doc.text('Aucun élève dans cette classe.');
    footer(doc, context);
  }

  return render(doc);
}

/** Bulletin annuel, tableau de synthèse : une ligne par élève, une colonne par période, puis la moyenne annuelle. */
export function generateAnnualClassBulletinPdf(
  context: BulletinContext,
  terms: { label: string }[],
  students: AnnualStudentResult[],
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN });

  header(doc, context, 'Tableau des moyennes annuelles');

  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  const nameWidth = 150;
  const availableWidth = width - nameWidth - 70;
  const columnWidth = terms.length > 0 ? availableWidth / terms.length : availableWidth;

  const drawColumnHeader = (top: number): number => {
    doc.rect(left, top - 3, width, 18).fill(COLORS.band);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.text);
    doc.text('Élève', left + 4, top, { width: nameWidth });
    terms.forEach((term, index) => {
      doc.text(term.label, left + nameWidth + index * columnWidth, top, {
        width: columnWidth,
        align: 'center',
        ellipsis: true,
      });
    });
    doc.text('Moy. annuelle', left + nameWidth + terms.length * columnWidth, top, {
      width: 66,
      align: 'right',
    });
    doc.font('Helvetica').fontSize(8);
    return top + 20;
  };

  let y = drawColumnHeader(doc.y + 4);

  for (const student of students) {
    if (y > doc.page.height - MARGIN - 40) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN });
      header(doc, context, 'Tableau des moyennes annuelles');
      y = drawColumnHeader(doc.y + 4);
    }

    doc.fillColor(COLORS.text);
    doc.text(`${student.lastName.toUpperCase()} ${student.firstName}`, left + 4, y, {
      width: nameWidth,
      ellipsis: true,
    });

    terms.forEach((_, index) => {
      doc.text(format(student.termAverages[index] ?? null), left + nameWidth + index * columnWidth, y, {
        width: columnWidth,
        align: 'center',
      });
    });

    doc.font('Helvetica-Bold');
    doc.text(format(student.average), left + nameWidth + terms.length * columnWidth, y, {
      width: 66,
      align: 'right',
    });
    doc.font('Helvetica');

    y += 16;
    doc.moveTo(left, y - 4).lineTo(left + width, y - 4).strokeColor(COLORS.line).lineWidth(0.5).stroke();
  }

  y += 6;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.text);
  doc.text(`Moyenne annuelle de la classe : ${format(context.classAverage)}`, left + 4, y);

  footer(doc, context);

  return render(doc);
}

/**
 * `null` s'affiche « — », jamais « 0 ». La distinction est visible sur le
 * document imprimé remis aux familles.
 */
function format(average: number | null): string {
  return average === null ? '—' : average.toFixed(2).replace('.', ',');
}
