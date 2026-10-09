-- CreateTable
CREATE TABLE "stream_weight_actor_parameters" (
    "epoch" BIGINT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "base_atto_usd" DECIMAL(78,0) NOT NULL,
    "step_ratio" DECIMAL(78,0) NOT NULL,
    "steps" BIGINT NOT NULL,

    CONSTRAINT "stream_weight_actor_parameters_pkey" PRIMARY KEY ("epoch","log_index")
);

-- CreateTable
CREATE TABLE "quarterly_gate_check" (
    "epoch" BIGINT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "quarter" BIGINT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "steps_after" BIGINT NOT NULL,
    "steps_before" BIGINT NOT NULL,

    CONSTRAINT "quarterly_gate_check_pkey" PRIMARY KEY ("epoch","log_index")
);

-- CreateIndex
CREATE INDEX "stream_weight_actor_parameters_epoch_idx" ON "stream_weight_actor_parameters"("epoch");

-- CreateIndex
CREATE INDEX "quarterly_gate_check_quarter_idx" ON "quarterly_gate_check"("quarter");
