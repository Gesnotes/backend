-- DropForeignKey
ALTER TABLE "grades" DROP CONSTRAINT "grades_school_id_fkey";

-- DropForeignKey
ALTER TABLE "grades" DROP CONSTRAINT "grades_student_id_fkey";

-- DropIndex
DROP INDEX "users_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "students_id_school_id_key" ON "students"("id", "school_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_school_id_email_key" ON "users"("school_id", "email");

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_student_id_school_id_fkey" FOREIGN KEY ("student_id", "school_id") REFERENCES "students"("id", "school_id") ON DELETE CASCADE ON UPDATE CASCADE;
