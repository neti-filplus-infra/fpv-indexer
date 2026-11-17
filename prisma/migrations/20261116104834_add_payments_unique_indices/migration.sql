/*
  Warnings:

  - A unique constraint covering the columns `[tx_hash,log_index]` on the table `filecoin_pay_payment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tx_hash,tx_position,call_index]` on the table `filecoin_pay_payment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "filecoin_pay_payment_tx_hash_log_index_key" ON "filecoin_pay_payment"("tx_hash", "log_index");

-- CreateIndex
CREATE UNIQUE INDEX "filecoin_pay_payment_tx_hash_tx_position_call_index_key" ON "filecoin_pay_payment"("tx_hash", "tx_position", "call_index") WHERE ("call_index" IS NOT NULL);
