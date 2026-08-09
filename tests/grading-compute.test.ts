import { describe, expect, it } from 'vitest';

import { Prisma } from '../src/generated/prisma/client';
import {
  type GradeInput,
  averageOf,
  generalAverage,
  normalizeToTwenty,
  serializeAverage,
  subjectAverage,
} from '../src/services/grading/compute';

const D = (n: number | string) => new Prisma.Decimal(n);

// Poids par défaut du plan : interrogation 1, devoir 2, composition 3.
const INTERRO = 1;
const DEVOIR = 2;
const COMPO = 3;

const CODES: Record<number, string> = {
  [INTERRO]: 'interrogation',
  [DEVOIR]: 'devoir',
  [COMPO]: 'composition',
};

const grade = (gradeTypeId: number, value: number, maxValue = 20): GradeInput => ({
  gradeTypeId,
  code: CODES[gradeTypeId] ?? 'interrogation',
  weight: D(gradeTypeId), // l'id vaut le poids dans ces jeux d'essai
  value: D(value),
  maxValue: D(maxValue),
});

const round = (d: Prisma.Decimal | null) => serializeAverage(d);

/**
 * Ces tests ne touchent pas la base : c'est ce qui permet de couvrir chaque
 * cas limite du plan §4 exhaustivement. Une moyenne fausse est invisible en
 * production — elle ne lève aucune erreur, elle affiche juste un mauvais
 * chiffre à un parent.
 */
describe('normalisation sur 20', () => {
  it('convertit une note sur 10', () => {
    expect(round(normalizeToTwenty(D(8), D(10)))).toBe(16);
  });

  it('laisse une note sur 20 inchangée', () => {
    expect(round(normalizeToTwenty(D(13.5), D(20)))).toBe(13.5);
  });

  it('refuse une valeur maximale nulle ou négative', () => {
    expect(() => normalizeToTwenty(D(10), D(0))).toThrow();
    expect(() => normalizeToTwenty(D(10), D(-20))).toThrow();
  });
});

describe('moyenne par matière', () => {
  it("applique l'exemple du plan : interros 12/15/9, devoir 14, compo 16", () => {
    // M_interro = (12+15+9)/3 = 12
    // (12 + 2×14 + 3×16) / 6 = (12 + 28 + 48) / 6 = 88/6 = 14.666...
    const average = subjectAverage([
      grade(INTERRO, 12),
      grade(INTERRO, 15),
      grade(INTERRO, 9),
      grade(DEVOIR, 14),
      grade(COMPO, 16),
    ]);
    expect(round(average)).toBe(14.67);
  });

  it('cumule les interrogations en une seule note avant pondération', () => {
    // Trois interros identiques ne doivent pas peser trois fois plus. Devoir
    // et composition ajoutés pour passer le seuil de publication.
    const trois = subjectAverage([
      grade(INTERRO, 10),
      grade(INTERRO, 10),
      grade(INTERRO, 10),
      grade(DEVOIR, 12),
      grade(COMPO, 20),
    ]);
    const une = subjectAverage([grade(INTERRO, 10), grade(DEVOIR, 12), grade(COMPO, 20)]);
    expect(round(trois)).toBe(round(une));
  });

  it('ne publie aucune moyenne sans devoir ET composition — choix de l\'établissement', () => {
    // Interros seules, ou interro + devoir sans composition : quelques
    // interrogations ne suffisent pas à juger un trimestre.
    expect(subjectAverage([grade(INTERRO, 12)])).toBeNull();
    expect(subjectAverage([grade(INTERRO, 12), grade(DEVOIR, 14)])).toBeNull();
    expect(subjectAverage([grade(COMPO, 16)])).toBeNull();
  });

  it('publie la moyenne dès que devoir et composition sont tous deux présents', () => {
    // (2×14 + 3×16) / 5 = (28+48)/5 = 15.2 — l'interrogation n'est pas requise.
    const average = subjectAverage([grade(DEVOIR, 14), grade(COMPO, 16)]);
    expect(round(average)).toBe(15.2);
  });

  it('gère plusieurs devoirs et plusieurs compositions', () => {
    // M_devoir = (10+14)/2 = 12 ; M_compo = (15+17)/2 = 16
    // (2×12 + 3×16) / 5 = (24+48)/5 = 14.4
    const average = subjectAverage([
      grade(DEVOIR, 10),
      grade(DEVOIR, 14),
      grade(COMPO, 15),
      grade(COMPO, 17),
    ]);
    expect(round(average)).toBe(14.4);
  });

  it('normalise avant de pondérer', () => {
    // Devoir 8/10 = 16/20, composition 16/20.
    const average = subjectAverage([grade(DEVOIR, 8, 10), grade(COMPO, 16)]);
    expect(round(average)).toBe(16);
  });

  it('renvoie null sans aucune note, jamais 0', () => {
    expect(subjectAverage([])).toBeNull();
    expect(round(subjectAverage([]))).toBeNull();
  });

  it('renvoie null si toutes les catégories ont un poids nul', () => {
    const zeroDevoir: GradeInput = { gradeTypeId: DEVOIR, code: 'devoir', weight: D(0), value: D(12), maxValue: D(20) };
    const zeroCompo: GradeInput = { gradeTypeId: COMPO, code: 'composition', weight: D(0), value: D(15), maxValue: D(20) };
    expect(subjectAverage([zeroDevoir, zeroCompo])).toBeNull();
  });

  it('accepte une note de 0 sans la confondre avec une absence de note', () => {
    const average = subjectAverage([grade(DEVOIR, 12), grade(COMPO, 0)]);
    // (2×12 + 3×0) / 5 = 4.8 — la composition à 0 pèse bien dans le calcul,
    // elle n'est pas traitée comme une absence de note.
    expect(round(average)).toBe(4.8);
    expect(average).not.toBeNull();
  });
});

describe('moyenne générale', () => {
  it('pondère par le coefficient de chaque matière', () => {
    // (15×4 + 10×1) / 5 = 70/5 = 14
    const average = generalAverage([
      { average: D(15), coefficient: D(4) },
      { average: D(10), coefficient: D(1) },
    ]);
    expect(round(average)).toBe(14);
  });

  it("exclut du dénominateur le coefficient d'une matière non notée", () => {
    // Maths coef 4 notée 15, Physique coef 6 sans note : la moyenne vaut 15,
    // pas (15×4)/(4+6) = 6.
    const average = generalAverage([{ average: D(15), coefficient: D(4) }]);
    expect(round(average)).toBe(15);
    expect(round(average)).not.toBe(6);
  });

  it('renvoie null quand aucune matière n\'est notée', () => {
    expect(generalAverage([])).toBeNull();
  });

  it('renvoie null si tous les coefficients sont nuls', () => {
    expect(generalAverage([{ average: D(15), coefficient: D(0) }])).toBeNull();
  });
});

describe('précision et arrondi', () => {
  it("n'arrondit qu'à la sérialisation", () => {
    // 1/3 en Decimal conserve sa précision ; seul serializeAverage arrondit.
    const average = averageOf([D(10), D(10), D(11)]);
    expect(average?.toFixed(10)).toBe('10.3333333333');
    expect(round(average)).toBe(10.33);
  });

  it('ne dérive pas sur un enchaînement de calculs', () => {
    // 0.1 + 0.2 en flottant donne 0.30000000000000004 ; pas en Decimal.
    const average = averageOf([D('0.1'), D('0.2')]);
    expect(average?.toString()).toBe('0.15');
  });

  it('conserve la valeur exacte des demi-points', () => {
    expect(round(subjectAverage([grade(DEVOIR, 13.5), grade(COMPO, 13.5)]))).toBe(13.5);
  });
});

describe('moyenne arithmétique', () => {
  it('renvoie null sur une liste vide', () => {
    expect(averageOf([])).toBeNull();
  });

  it('moyenne correctement une liste non vide', () => {
    expect(round(averageOf([D(12), D(15), D(9)]))).toBe(12);
  });
});
