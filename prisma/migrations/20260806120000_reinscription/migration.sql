-- Trace des reinscriptions : un eleve deplace de fromClass vers toClass a la
-- preparation d'une rentree, avec la decision qui l'explique (monte, redouble,
-- ou autre). Pur historique, ne porte aucune contrainte sur Student.class_id.

-- CreateEnum
CREATE TYPE "enrollment_decision_type" AS ENUM ('promotion', 'redoublement', 'autre');

-- CreateTable
CREATE TABLE "enrollment_decisions" (
    "id" SERIAL NOT NULL,
    "school_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "from_class_id" INTEGER NOT NULL,
    "to_class_id" INTEGER NOT NULL,
    "decision" "enrollment_decision_type" NOT NULL,
    "decided_by_user_id" INTEGER,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex : porte l'historique d'une classe qui a prepare sa rentree.
CREATE INDEX "enrollment_decisions_from_class_id_created_at_idx" ON "enrollment_decisions"("from_class_id", "created_at");

-- CreateIndex
CREATE INDEX "enrollment_decisions_student_id_idx" ON "enrollment_decisions"("student_id");

-- AddForeignKey
ALTER TABLE "enrollment_decisions" ADD CONSTRAINT "enrollment_decisions_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_decisions" ADD CONSTRAINT "enrollment_decisions_from_class_id_school_id_fkey" FOREIGN KEY ("from_class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_decisions" ADD CONSTRAINT "enrollment_decisions_to_class_id_school_id_fkey" FOREIGN KEY ("to_class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_decisions" ADD CONSTRAINT "enrollment_decisions_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
