-- Create admission table
CREATE TABLE "service_orchestrator_admission" (
    "service_orchestrator_id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "admission_epoch" BIGINT NOT NULL,
    "admission_log_index" INTEGER NOT NULL,
    "admission_tx_hash" TEXT NOT NULL,
    "removal_epoch" BIGINT,
    "removal_log_index" INTEGER,
    "removal_tx_hash" TEXT,

    CONSTRAINT "service_orchestrator_admission_pkey" PRIMARY KEY ("service_orchestrator_id","admission_epoch","admission_log_index")
);

-- Create unique index for only one active admission per orchestrator
CREATE UNIQUE INDEX "service_orchestrator_admission_service_orchestrator_id_key" ON "service_orchestrator_admission"("service_orchestrator_id") WHERE ("removal_epoch" IS NULL);

-- Add foreign key referencing id table
ALTER TABLE "service_orchestrator_admission" ADD CONSTRAINT "service_orchestrator_admission_service_orchestrator_id_fkey" FOREIGN KEY ("service_orchestrator_id") REFERENCES "service_orchestrator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Copy entries from id table to admissions table
INSERT INTO "service_orchestrator_admission" (
  "service_orchestrator_id",
  "wallet",
  "admission_epoch",
  "admission_log_index",
  "admission_tx_hash",
  "removal_epoch",
  "removal_log_index",
  "removal_tx_hash"
)
SELECT
  "id",
  "wallet",
  "registration_epoch",
  -- Previous schema did not index admission event, setting it to 0 does not 
  -- reflect on chain data but does not break logic. Full database reset would
  -- be required otherwise.
  0,
  "registration_tx_hash",
  "removal_epoch",
  -- Previous schema did not index removal event. Same reasoning as with
  -- admission epoch applies.
  NULL,
  "removal_tx_hash"
FROM "service_orchestrator";

-- Drop fields that are either obsolete or moved to admissions table
ALTER TABLE "service_orchestrator" DROP COLUMN "registration_epoch",
DROP COLUMN "registration_tx_hash",
DROP COLUMN "removal_epoch",
DROP COLUMN "removal_tx_hash",
DROP COLUMN "removed",
DROP COLUMN "wallet";