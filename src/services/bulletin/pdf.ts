import PDFDocument from 'pdfkit';

import type { AnnualStudentResult, StudentResult } from '../grading/grading.service';

/**
 * Génération des bulletins en PDF.
 *
 * Le bulletin est la pièce que les parents contestent : il doit être
 * **auditable**. Chaque moyenne de matière est accompagnée du détail par
 * catégorie (interrogation / devoir / composition) et du coefficient appliqué,
 * pour qu'un parent puisse refaire le calcul à la main.
 */

export interface BulletinContext {
  schoolName: string;
  className: string;
  level: string;
  termLabel: string;
  classAverage: number | null;
  /** Texte libre affiché sous le nom de l'école, tel que réglé dans Paramètres. */
  bulletinHeader?: string | null;
  /** Texte libre affiché en pied de page, au-dessus de la mention générique. */
  bulletinFooter?: string | null;
}

const MARGIN = 36;
/** Largeur de la colonne « Détail des notes », partagée mesure et rendu. */
const DETAIL_WIDTH = 260;
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

function header(doc: PDFKit.PDFDocument, context: BulletinContext, title: string) {
  doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.text).text(context.schoolName);

  if (context.bulletinHeader) {
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.text);
    doc.text(context.bulletinHeader, { width: doc.page.width - MARGIN * 2 });
  }

  doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted);
  doc.text(`${title} — ${context.className} (${context.level}) — ${context.termLabel}`);
  doc.moveDown(0.8);
}

const GENERIC_FOOTER_LINE =
  'Gesnotes. Moyennes calculées à la volée, jamais stockées.';

/**
 * Pied de page : le texte propre à l'école (réglé dans Paramètres), s'il y en
 * a un, puis toujours la mention générique en dessous — jamais l'un à la
 * place de l'autre, la mention technique reste utile même personnalisée.
 */
function footer(doc: PDFKit.PDFDocument, context: BulletinContext) {
  const width = doc.page.width - MARGIN * 2;
  const genericLine = `Généré le ${new Date().toLocaleDateString('fr-FR')} — ${GENERIC_FOOTER_LINE}`;

  let y = doc.page.height - MARGIN - 10;

  if (context.bulletinFooter) {
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.text);
    const customHeight = doc.heightOfString(context.bulletinFooter, { width });
    y -= customHeight + 4;
    doc.text(context.bulletinFooter, MARGIN, y, { width, align: 'center' });
    y = doc.page.height - MARGIN - 10;
  }

  doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted);
  doc.text(genericLine, MARGIN, y, { width, align: 'center' });
}

/** Format « une page par élève » : le document remis à la famille. */
export function generateStudentBulletinPdf(
  context: BulletinContext,
  students: StudentResult[],
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN });

  students.forEach((student, index) => {
    if (index > 0) doc.addPage();

    header(doc, context, 'Bulletin scolaire');

    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.text);
    doc.text(`${student.lastName.toUpperCase()} ${student.firstName}`);
    doc.moveDown(0.5);

    const left = MARGIN;
    const width = doc.page.width - MARGIN * 2;
    const columns = {
      subject: left,
      categories: left + 150,
      coefficient: left + width - 150,
      average: left + width - 70,
    };

    // En-tête du tableau
    let y = doc.y + 4;
    doc.rect(left, y - 3, width, 18).fill(COLORS.band);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.text);
    doc.text('Matière', columns.subject + 4, y, { width: 140 });
    doc.text('Détail des notes', columns.categories, y, { width: DETAIL_WIDTH });
    doc.text('Coef.', columns.coefficient, y, { width: 60, align: 'right' });
    doc.text('Moyenne', columns.average, y, { width: 66, align: 'right' });
    y += 20;

    doc.font('Helvetica').fontSize(9);

    for (const subject of student.subjects) {
      if (y > doc.page.height - MARGIN - 70) {
        doc.addPage();
        y = MARGIN;
      }

      const detail = subject.categories
        .map((c) => `${c.label} ×${c.weight} : ${format(c.average)}`)
        .join('   ');

      // Hauteur mesurée, pas fixée : le détail des catégories dépasse souvent
      // la largeur de sa colonne et passe sur deux lignes. Avec un pas figé,
      // il chevaucherait la matière suivante — sur la partie du bulletin qui
      // permet justement au parent de refaire le calcul.
      doc.fontSize(8);
      const detailHeight = doc.heightOfString(detail || '—', { width: DETAIL_WIDTH });
      const rowHeight = Math.max(18, detailHeight + 8);

      doc.fontSize(9).fillColor(COLORS.text);
      doc.text(subject.subjectName, columns.subject + 4, y, { width: 140 });
      doc.fillColor(COLORS.muted).fontSize(8).text(detail || '—', columns.categories, y, {
        width: DETAIL_WIDTH,
      });
      doc.fontSize(9).fillColor(COLORS.text);
      doc.text(String(subject.coefficient), columns.coefficient, y, { width: 60, align: 'right' });
      doc.font('Helvetica-Bold').text(format(subject.average), columns.average, y, {
        width: 66,
        align: 'right',
      });
      doc.font('Helvetica');

      y += rowHeight;
      doc.moveTo(left, y - 4).lineTo(left + width, y - 4).strokeColor(COLORS.line).lineWidth(0.5).stroke();
    }

    // Synthèse
    y += 8;
    doc.rect(left, y - 4, width, 22).fill(COLORS.band);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text);
    doc.text('Moyenne générale', columns.subject + 4, y + 2, { width: 200 });
    doc.text(format(student.average), columns.average, y + 2, { width: 66, align: 'right' });

    y += 26;
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
    doc.text(`Moyenne de la classe : ${format(context.classAverage)}`, columns.subject + 4, y);

    if (student.average === null) {
      doc.moveDown(0.6);
      doc.fillColor(COLORS.muted).fontSize(8);
      doc.text(
        "Aucune note n'a encore été saisie pour cet élève sur cette période. L'absence de moyenne ne vaut pas zéro.",
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
