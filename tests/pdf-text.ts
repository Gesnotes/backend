import zlib from 'node:zlib';

/**
 * Extrait le texte d'un PDF produit par PDFKit.
 *
 * Sans cet outil, les tests ne pouvaient vérifier qu'une chose : que le
 * fichier commence par `%PDF-`. Un bulletin affichant des moyennes fausses,
 * vides, ou celles d'un autre élève passait au vert.
 *
 * Les flux sont compressés en Flate ; on les décompresse puis on récupère les
 * chaînes des opérateurs de texte. PDFKit les écrit en hexadécimal dans des
 * tableaux `TJ` — `[<436f6c6ce867> -10 <652058>] TJ` — encodées en WinAnsi,
 * compatible latin1 pour les caractères français.
 */
/**
 * WinAnsi n'est pas latin1 : la plage 0x80–0x9F y porte des caractères
 * typographiques (le tiret cadratin « — » est en 0x97) que latin1 rendrait
 * comme des caractères de contrôle. Décoder en latin1 ferait disparaître le
 * « — » des bulletins, et donc croire à tort qu'il n'est pas imprimé.
 */
const WIN_ANSI = new TextDecoder('windows-1252');

export function extractPdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const parts: string[] = [];
  const streamStart = /stream\r?\n/g;

  let match: RegExpExecArray | null;
  while ((match = streamStart.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;

    let content = pdf.subarray(start, end);
    try {
      content = zlib.inflateSync(content);
    } catch {
      // Flux déjà en clair (police, image) : on le laisse tel quel.
    }

    const text = content.toString('latin1');

    // Chaînes hexadécimales : la forme utilisée par PDFKit.
    for (const hex of text.matchAll(/<([0-9a-fA-F]+)>/g)) {
      const value = hex[1];
      if (!value || value.length % 2 !== 0) continue;
      parts.push(WIN_ANSI.decode(Buffer.from(value, 'hex')));
    }

    // Chaînes littérales, au cas où la police change un jour.
    for (const literal of text.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      parts.push(literal[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
    }
  }

  return parts.join(' ');
}

/**
 * Texte sans aucune espace.
 *
 * Le crénage de PDFKit découpe les mots en fragments (« Mo y enne », « Collèg
 * e X ») : comparer sur le texte brut donnerait des tests faux-négatifs. Les
 * assertions portent donc sur la version compactée.
 */
export function pdfTextOf(pdf: Buffer): string {
  return extractPdfText(pdf).replace(/\s+/g, '');
}
