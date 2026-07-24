-- DropForeignKey
ALTER TABLE "classes" DROP CONSTRAINT "classes_school_id_fkey";

-- DropForeignKey
ALTER TABLE "devices" DROP CONSTRAINT "devices_user_id_fkey";

-- DropForeignKey
ALTER TABLE "grades" DROP CONSTRAINT "grades_student_id_fkey";

-- DropForeignKey
ALTER TABLE "grades" DROP CONSTRAINT "grades_subject_id_fkey";

-- DropForeignKey
ALTER TABLE "grades" DROP CONSTRAINT "grades_term_id_fkey";

-- DropForeignKey
ALTER TABLE "student_parents" DROP CONSTRAINT "student_parents_parent_user_id_fkey";

-- DropForeignKey
ALTER TABLE "student_parents" DROP CONSTRAINT "student_parents_student_id_fkey";

-- DropForeignKey
ALTER TABLE "students" DROP CONSTRAINT "students_class_id_fkey";

-- DropForeignKey
ALTER TABLE "students" DROP CONSTRAINT "students_school_id_fkey";

-- DropForeignKey
ALTER TABLE "subjects" DROP CONSTRAINT "subjects_school_id_fkey";

-- DropForeignKey
ALTER TABLE "teacher_assignments" DROP CONSTRAINT "teacher_assignments_class_id_fkey";

-- DropForeignKey
ALTER TABLE "teacher_assignments" DROP CONSTRAINT "teacher_assignments_subject_id_fkey";

-- DropForeignKey
ALTER TABLE "teacher_assignments" DROP CONSTRAINT "teacher_assignments_teacher_user_id_fkey";

-- DropForeignKey
ALTER TABLE "terms" DROP CONSTRAINT "terms_school_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_school_id_fkey";

-- AlterTable
ALTER TABLE "classes" ADD COLUMN     "archived_at" TIMESTAMP(6),
ADD COLUMN     "level" VARCHAR(20) NOT NULL,
ALTER COLUMN "school_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "devices" ALTER COLUMN "user_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "grades" DROP COLUMN "coefficient",
DROP COLUMN "grade_type",
ADD COLUMN     "grade_type_id" INTEGER NOT NULL,
ADD COLUMN     "school_id" INTEGER NOT NULL,
ALTER COLUMN "student_id" SET NOT NULL,
ALTER COLUMN "subject_id" SET NOT NULL,
ALTER COLUMN "term_id" SET NOT NULL,
ALTER COLUMN "max_value" SET NOT NULL;

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "archived_at" TIMESTAMP(6),
ALTER COLUMN "school_id" SET NOT NULL,
ALTER COLUMN "class_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "subjects" ADD COLUMN     "archived_at" TIMESTAMP(6),
ALTER COLUMN "school_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "teacher_assignments" ALTER COLUMN "teacher_user_id" SET NOT NULL,
ALTER COLUMN "class_id" SET NOT NULL,
ALTER COLUMN "subject_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "terms" ALTER COLUMN "school_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "archived_at" TIMESTAMP(6),
ADD COLUMN     "phone" VARCHAR(30),
ALTER COLUMN "school_id" SET NOT NULL;

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "revoked_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "used_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_coefficients" (
    "subject_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "coefficient" DECIMAL(4,2) NOT NULL,

    CONSTRAINT "subject_coefficients_pkey" PRIMARY KEY ("subject_id","class_id")
);

-- CreateTable
CREATE TABLE "grade_types" (
    "id" SERIAL NOT NULL,
    "school_id" INTEGER NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "weight" DECIMAL(4,2) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "grade_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_used_at_idx" ON "password_reset_tokens"("user_id", "used_at");

-- CreateIndex
CREATE UNIQUE INDEX "grade_types_school_id_code_key" ON "grade_types"("school_id", "code");

-- CreateIndex
CREATE INDEX "classes_school_id_archived_at_idx" ON "classes"("school_id", "archived_at");

-- CreateIndex
CREATE INDEX "grades_student_id_term_id_idx" ON "grades"("student_id", "term_id");

-- CreateIndex
CREATE INDEX "grades_school_id_created_at_idx" ON "grades"("school_id", "created_at");

-- CreateIndex
CREATE INDEX "grades_subject_id_term_id_idx" ON "grades"("subject_id", "term_id");

-- CreateIndex
CREATE INDEX "students_class_id_archived_at_idx" ON "students"("class_id", "archived_at");

-- CreateIndex
CREATE INDEX "students_school_id_archived_at_idx" ON "students"("school_id", "archived_at");

-- CreateIndex
CREATE INDEX "subjects_school_id_archived_at_idx" ON "subjects"("school_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_assignments_teacher_user_id_class_id_subject_id_key" ON "teacher_assignments"("teacher_user_id", "class_id", "subject_id");

-- CreateIndex
CREATE INDEX "users_school_id_archived_at_idx" ON "users"("school_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_school_id_phone_key" ON "users"("school_id", "phone");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_coefficients" ADD CONSTRAINT "subject_coefficients_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_coefficients" ADD CONSTRAINT "subject_coefficients_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_types" ADD CONSTRAINT "grade_types_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_parents" ADD CONSTRAINT "student_parents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_parents" ADD CONSTRAINT "student_parents_parent_user_id_fkey" FOREIGN KEY ("parent_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_teacher_user_id_fkey" FOREIGN KEY ("teacher_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignments" ADD CONSTRAINT "teacher_assignments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_grade_type_id_fkey" FOREIGN KEY ("grade_type_id") REFERENCES "grade_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
