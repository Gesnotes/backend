import 'dotenv/config';

import prisma from '../src/lib/prisma';
import { labelKey } from '../src/lib/normalize';

/**
 * Fusionne les matières en doublon d'une même école.
 *
 * La garde d'unicité empêche désormais d'en créer, mais les bases déjà
 * polluées gardent leurs doublons — deux « Mathématiques » / « Mathematiques »
 * nés avant la garde. Ce script rattache notes, affectations et coefficients
 * du doublon vers la matière conservée, puis supprime le doublon.
 *
 * On conserve celle qui porte le plus de notes ; à égalité, la plus ancienne.
 * À défaut de meilleur critère, c'est celle sur laquelle repose le plus de
 * travail déjà saisi.
 *
 *   npm run prisma:dedupe-subjects
 *
 * Idempotent : une base déjà propre n'est pas touchée.
 */
async function main() {
  const schools = await prisma.school.findMany({ select: { id: true, subdomain: true } });
  let merged = 0;

  for (const school of schools) {
    const subjects = await prisma.subject.findMany({
      where: { schoolId: school.id },
      select: { id: true, name: true, _count: { select: { grades: true } } },
      orderBy: { id: 'asc' },
    });

    const groups = new Map<string, typeof subjects>();
    for (const subject of subjects) {
      const key = labelKey(subject.name);
      groups.set(key, [...(groups.get(key) ?? []), subject]);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;

      // La matière conservée : celle qui porte le plus de notes, sinon la plus
      // ancienne (id le plus bas).
      const keeper = [...group].sort(
        (a, b) => b._count.grades - a._count.grades || a.id - b.id,
      )[0]!;
      const dupes = group.filter((subject) => subject.id !== keeper.id);

      for (const dupe of dupes) {
        await prisma.$transaction(async (tx) => {
          await tx.grade.updateMany({
            where: { subjectId: dupe.id },
            data: { subjectId: keeper.id },
          });
          await tx.teacherAssignment.updateMany({
            where: { subjectId: dupe.id },
            data: { subjectId: keeper.id },
          });

          // Coefficients : ne migrer que ceux dont la classe n'a pas déjà un
          // coefficient sur la matière conservée, la clé (subject, class) étant
          // unique. Les autres sont simplement abandonnés.
          const dupeCoefs = await tx.subjectCoefficient.findMany({
            where: { subjectId: dupe.id },
            select: { classId: true },
          });
          const keeperClasses = new Set(
            (
              await tx.subjectCoefficient.findMany({
                where: { subjectId: keeper.id },
                select: { classId: true },
              })
            ).map((c) => c.classId),
          );
          const movableClassIds = dupeCoefs
            .map((c) => c.classId)
            .filter((classId) => !keeperClasses.has(classId));

          if (movableClassIds.length > 0) {
            await tx.subjectCoefficient.updateMany({
              where: { subjectId: dupe.id, classId: { in: movableClassIds } },
              data: { subjectId: keeper.id },
            });
          }
          await tx.subjectCoefficient.deleteMany({ where: { subjectId: dupe.id } });

          await tx.subject.delete({ where: { id: dupe.id } });
        });

        merged += 1;
        console.log(
          `[${school.subdomain}] « ${dupe.name} » (#${dupe.id}) fusionnée dans « ${keeper.name} » (#${keeper.id})`,
        );
      }
    }
  }

  console.log(merged === 0 ? 'Aucun doublon à fusionner.' : `${merged} doublon(s) fusionné(s).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
