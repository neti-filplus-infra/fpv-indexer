/*
  WARNING! This migration is a breaking change.
  The indexer major version should be updated when publishing it to resync DB.
*/

TRUNCATE TABLE "service_pair";

ALTER TABLE "service_pair"
ADD COLUMN "binding_log_index" INT NOT NULL,
ADD COLUMN "unbinding_log_index" INT;
