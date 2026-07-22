-- AlterTable
ALTER TABLE "grades" ADD COLUMN     "comment" TEXT;

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "subdomain" VARCHAR(63) NOT NULL;

-- CreateTable
CREATE TABLE "devices" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "fcm_token" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_fcm_token_key" ON "devices"("fcm_token");

-- CreateIndex
CREATE UNIQUE INDEX "schools_subdomain_key" ON "schools"("subdomain");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
