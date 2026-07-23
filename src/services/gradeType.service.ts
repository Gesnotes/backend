import prisma from '../lib/prisma';

/**
 * Catégories de notes (interrogation, devoir, composition) et leur poids.
 *
 * `POST /grades` exige un `gradeTypeId` : sans route pour lister les
 * catégories, un enseignant ne peut pas saisir la moindre note depuis un
 * client. Le poids est exposé parce qu'il explique le calcul des moyennes —
 * c'est le chiffre que les familles contestent.
 */

export interface GradeTypeView {
  id: number;
  code: string;
  label: string;
  weight: number;
  position: number;
}

export async function listGradeTypes(schoolId: number): Promise<GradeTypeView[]> {
  const gradeTypes = await prisma.gradeType.findMany({
    where: { schoolId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: { id: true, code: true, label: true, weight: true, position: true },
  });

  // `weight` est un Decimal Prisma : sérialisé tel quel, il partirait en
  // chaîne ("2") alors que le reste de l'API expose des nombres.
  return gradeTypes.map((gradeType) => ({
    ...gradeType,
    weight: Number(gradeType.weight),
  }));
}
