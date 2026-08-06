-- Mode par classe (notes / presence) et presence quotidienne, pour la
-- maternelle et la garderie ou seule la presence compte. Les deux modes sont
-- mutuellement exclusifs (garde-fou applicatif dans evaluation.service.ts).

-- CreateEnum
CREATE TYPE "class_mode" AS ENUM ('notes', 'presence');

-- CreateEnum
CREATE TYPE "attendance_status" AS ENUM ('present', 'absent', 'late');

-- AlterTable
ALTER TABLE "classes"
  ADD COLUMN "mode" "class_mode" NOT NULL DEFAULT 'notes',
  ADD COLUMN "homeroom_teacher_id" INTEGER;

-- CreateTable
CREATE TABLE "attendances" (
    "id" SERIAL NOT NULL,
    "school_id" INTEGER NOT NULL,
    "student_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "status" "attendance_status" NOT NULL,
    "comment" TEXT,
    "recorded_by_user_id" INTEGER,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex : un seul statut par eleve et par jour.
CREATE UNIQUE INDEX "attendances_student_id_date_key" ON "attendances"("student_id", "date");

-- CreateIndex : porte la feuille de presence d'une classe pour un jour.
CREATE INDEX "attendances_class_id_date_idx" ON "attendances"("class_id", "date");

-- AddForeignKey
-- Restrict explicite : school_id n'est pas nullable, un SetNull par defaut
-- echouerait a l'execution. deleteTeacherPermanently refuse deja la
-- suppression d'un referent en poste.
ALTER TABLE "classes" ADD CONSTRAINT "classes_homeroom_teacher_id_school_id_fkey" FOREIGN KEY ("homeroom_teacher_id", "school_id") REFERENCES "users"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_class_id_school_id_fkey" FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
