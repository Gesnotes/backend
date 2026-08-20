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
  email: string | null;
  phone: string | null;
  address: string | null;
  bulletinHeader: string | null;
  bulletinFooter: string | null;
}

const settingsSelect = {
  name: true, passingGrade: true, email: true, phone: true, address: true,
  bulletinHeader: true, bulletinFooter: true,
} as const;

function toView(school: {
  name: string;
  passingGrade: { toString(): string };
  email: string | null;
  phone: string | null;
  address: string | null;
  bulletinHeader: string | null;
  bulletinFooter: string | null;
}): SchoolSettingsView {
  return {
    name: school.name,
    passingGrade: Number(school.passingGrade),
    email: school.email,
    phone: school.phone,
    address: school.address,
    bulletinHeader: school.bulletinHeader,
    bulletinFooter: school.bulletinFooter,
  };
}

export async function getSchoolSettings(schoolId: number): Promise<SchoolSettingsView> {
  const school = await prisma.school.findUniqueOrThrow({
    where: { id: schoolId },
    select: settingsSelect,
  });
  return toView(school);
}

export interface UpdateSchoolSettingsInput {
  passingGrade?: number;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  bulletinHeader?: string | null;
  bulletinFooter?: string | null;
}

export async function updateSchoolSettings(
  schoolId: number,
  patch: UpdateSchoolSettingsInput,
): Promise<SchoolSettingsView> {
  const school = await prisma.school.update({
    where: { id: schoolId },
    data: patch,
    select: settingsSelect,
  });
  return toView(school);
}
