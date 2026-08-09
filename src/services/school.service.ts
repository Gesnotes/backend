import prisma from '../lib/prisma';

/**
 * Réglages de l'école courante.
 *
 * Le seuil de passage est purement déclaratif : le calcul de la moyenne
 * (`grading/compute.ts`) ne s'en sert pas, seul l'affichage l'utilise pour
 * dire si une moyenne est jugée suffisante par CETTE école — deux
 * établissements peuvent en attendre des choses différentes.
 */
export interface SchoolSettingsView {
  name: string;
  passingGrade: number;
}

function toView(school: { name: string; passingGrade: { toString(): string } }): SchoolSettingsView {
  return { name: school.name, passingGrade: Number(school.passingGrade) };
}

export async function getSchoolSettings(schoolId: number): Promise<SchoolSettingsView> {
  const school = await prisma.school.findUniqueOrThrow({
    where: { id: schoolId },
    select: { name: true, passingGrade: true },
  });
  return toView(school);
}

export async function updatePassingGrade(
  schoolId: number,
  passingGrade: number,
): Promise<SchoolSettingsView> {
  const school = await prisma.school.update({
    where: { id: schoolId },
    data: { passingGrade },
    select: { name: true, passingGrade: true },
  });
  return toView(school);
}
