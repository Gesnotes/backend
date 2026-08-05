/**
 * Génération de CSV lisibles par Excel en français.
 *
 * Trois détails font toute la différence entre un fichier qui s'ouvre d'un
 * double-clic et un fichier que l'école n'arrive pas à exploiter :
 *
 * 1. **le point-virgule** — Excel en locale française attend `;` ; avec une
 *    virgule, tout atterrit dans la première colonne ;
 * 2. **le BOM UTF-8** — sans lui, Excel lit le fichier en ANSI et « Sagbo
 *    Adjovi » devient « Sagbo AdjovÃ¯ » ;
 * 3. **la virgule décimale** — `13.75` est du texte pour Excel FR, `13,75` est
 *    un nombre. Une moyenne qu'on ne peut pas trier ne sert à rien.
 *
 * Le CSV a été préféré au `.xlsx` : aucune dépendance, et un fichier
 * réenregistré depuis Excel reste importable tel quel.
 */

const BOM = '﻿';
const SEPARATOR = ';';

/** Valeur admise dans une cellule. `null` et `undefined` donnent une cellule vide. */
export type CsvCell = string | number | null | undefined;

/**
 * Échappe une cellule.
 *
 * Les guillemets sont posés dès qu'un séparateur, un guillemet ou un saut de
 * ligne apparaît — un commentaire d'enseignant contient volontiers les trois.
 * Un `=` ou un `+` en tête est neutralisé par un guillemet simple : Excel
 * interpréterait sinon la cellule comme une formule, ce qui va du résultat
 * absurde à l'exécution de contenu venu d'un import.
 */
function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';

  const raw = typeof value === 'number' ? formatNumber(value) : String(value);
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;

  return /[";\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Nombre à la française : deux décimales, virgule décimale. */
export function formatNumber(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

/** Moyenne éventuellement absente. Le tiret dit « non évalué », jamais zéro. */
export function formatAverage(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : formatNumber(value);
}

/**
 * Assemble un CSV complet, BOM compris.
 *
 * CRLF plutôt que LF : c'est ce qu'attendent Excel et les tableurs Windows,
 * majoritaires dans les secrétariats.
 */
export function toCsv(rows: CsvCell[][]): string {
  return BOM + rows.map((row) => row.map(escapeCell).join(SEPARATOR)).join('\r\n') + '\r\n';
}

/**
 * Lit un CSV saisi à la main ou réenregistré depuis Excel.
 *
 * Tolérant par nécessité : le séparateur est déduit de la ligne d'en-tête
 * (`;` ou `,` selon la locale de qui a exporté), le BOM est retiré, et les
 * lignes vides sont ignorées — un fichier Excel en produit toujours en fin.
 * Gère les cellules entre guillemets, donc les noms composés contenant le
 * séparateur.
 */
export function parseCsv(content: string): string[][] {
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const separator = detectSeparator(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        // Guillemet doublé : un guillemet littéral, pas une fin de cellule.
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === separator) {
      row.push(cell.trim());
      cell = '';
    } else if (char === '\n') {
      row.push(cell.trim());
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some((value) => value !== '')) rows.push(row);

  return rows;
}

/** Le séparateur le plus fréquent sur la première ligne non vide. */
function detectSeparator(text: string): string {
  const header = text.split('\n').find((line) => line.trim() !== '') ?? '';
  const semicolons = (header.match(/;/g) ?? []).length;
  const commas = (header.match(/,/g) ?? []).length;
  return commas > semicolons ? ',' : ';';
}
