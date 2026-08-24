import prisma from '../lib/prisma';
import { badRequest } from '../errors/AppError';

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
  /** Une image d'en-tête/pied de page est réglée ; jamais son contenu ici (voir getBulletinImage). */
  hasBulletinHeaderImage: boolean;
  hasBulletinFooterImage: boolean;
}

const settingsSelect = {
  name: true, passingGrade: true, email: true, phone: true, address: true,
  bulletinHeaderImage: true, bulletinFooterImage: true,
} as const;

function toView(school: {
  name: string;
  passingGrade: { toString(): string };
  email: string | null;
  phone: string | null;
  address: string | null;
  bulletinHeaderImage: Uint8Array | null;
  bulletinFooterImage: Uint8Array | null;
}): SchoolSettingsView {
  return {
    name: school.name,
    passingGrade: Number(school.passingGrade),
    email: school.email,
    phone: school.phone,
    address: school.address,
    hasBulletinHeaderImage: school.bulletinHeaderImage !== null,
    hasBulletinFooterImage: school.bulletinFooterImage !== null,
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

// --------------------------------------------------- Images du bulletin

export type BulletinImageSlot = 'header' | 'footer';

export interface BulletinImage {
  data: Buffer;
  contentType: string;
}

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
};

/**
 * Signature d'octets réelle de chaque format accepté. Le type MIME déclaré
 * dans le data URL n'est qu'une prétention du client, jamais une preuve : un
 * fichier quelconque renommé « image/png » passait auparavant tel quel et ne
 * faisait planter la génération du bulletin (pdfkit, « Unknown image
 * format ») que bien plus tard, pour toute l'école à la fois — jamais à
 * l'upload, où l'erreur aurait été utile.
 */
const MAGIC_BYTES: Record<string, Buffer> = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
};

function hasMagicBytes(data: Buffer, contentType: string): boolean {
  const signature = MAGIC_BYTES[contentType];
  if (!signature) return false;
  return data.length >= signature.length && data.subarray(0, signature.length).equals(signature);
}

/**
 * PNG ou JPEG uniquement : ce sont les deux seuls formats que pdfkit sait
 * intégrer directement (voir bulletin/pdf.ts) — un SVG ou un WebP téléversés
 * échoueraient silencieusement à la génération du PDF, bien après que
 * l'école ait cru le réglage enregistré.
 */
const MAX_BULLETIN_IMAGE_BYTES = 1.5 * 1024 * 1024;

/** Décode un data URL (`data:image/png;base64,...`) tel qu'envoyé par le formulaire de Paramètres. */
function parseImageDataUrl(value: string): BulletinImage {
  const match = /^data:([^;]+);base64,(.+)$/.exec(value.trim());
  const mime = match?.[1]?.toLowerCase();
  const contentType = mime ? ALLOWED_IMAGE_TYPES[mime] : undefined;

  if (!match || !contentType) {
    throw badRequest('Image invalide : seuls les formats PNG et JPEG sont acceptés.');
  }

  const data = Buffer.from(match[2]!, 'base64');
  if (data.length === 0) {
    throw badRequest('Image invalide.');
  }
  if (data.length > MAX_BULLETIN_IMAGE_BYTES) {
    throw badRequest('Image trop lourde : 1,5 Mo maximum.');
  }
  if (!hasMagicBytes(data, contentType)) {
    throw badRequest('Image invalide : le fichier ne correspond pas au format déclaré.');
  }

  return { data, contentType };
}

export async function getBulletinImage(
  schoolId: number,
  slot: BulletinImageSlot,
): Promise<BulletinImage | null> {
  const school =
    slot === 'header'
      ? await prisma.school.findUniqueOrThrow({
          where: { id: schoolId },
          select: { bulletinHeaderImage: true, bulletinHeaderImageType: true },
        })
      : await prisma.school.findUniqueOrThrow({
          where: { id: schoolId },
          select: { bulletinFooterImage: true, bulletinFooterImageType: true },
        });

  const data = slot === 'header'
    ? (school as { bulletinHeaderImage: Uint8Array | null }).bulletinHeaderImage
    : (school as { bulletinFooterImage: Uint8Array | null }).bulletinFooterImage;
  const contentType = slot === 'header'
    ? (school as { bulletinHeaderImageType: string | null }).bulletinHeaderImageType
    : (school as { bulletinFooterImageType: string | null }).bulletinFooterImageType;

  if (!data || !contentType) return null;

  return { data: Buffer.from(data), contentType };
}

/** `dataUrl` : image encodée en base64 telle que produite par `FileReader.readAsDataURL`. */
export async function setBulletinImage(
  schoolId: number,
  slot: BulletinImageSlot,
  dataUrl: string,
): Promise<void> {
  const image = parseImageDataUrl(dataUrl);
  // `Buffer` porte un `ArrayBufferLike` (potentiellement un `SharedArrayBuffer`),
  // le client Prisma généré attend un `Uint8Array<ArrayBuffer>` strict.
  const bytes = new Uint8Array(image.data);

  if (slot === 'header') {
    await prisma.school.update({
      where: { id: schoolId },
      data: { bulletinHeaderImage: bytes, bulletinHeaderImageType: image.contentType },
    });
  } else {
    await prisma.school.update({
      where: { id: schoolId },
      data: { bulletinFooterImage: bytes, bulletinFooterImageType: image.contentType },
    });
  }
}

export async function removeBulletinImage(schoolId: number, slot: BulletinImageSlot): Promise<void> {
  if (slot === 'header') {
    await prisma.school.update({
      where: { id: schoolId },
      data: { bulletinHeaderImage: null, bulletinHeaderImageType: null },
    });
  } else {
    await prisma.school.update({
      where: { id: schoolId },
      data: { bulletinFooterImage: null, bulletinFooterImageType: null },
    });
  }
}
