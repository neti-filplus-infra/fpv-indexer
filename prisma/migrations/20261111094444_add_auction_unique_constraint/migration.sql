/*
  Warnings:

  - A unique constraint covering the columns `[filecoin_pay_contract_address,auctioned_at_epoch,tx_position,call_index]` on the table `filecoin_pay_fee_auction` will be added. If there are existing duplicate values, this will fail.
  - Made the column `call_index` on table `filecoin_pay_fee_auction` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "filecoin_pay_fee_auction" ALTER COLUMN "call_index" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "filecoin_pay_fee_auction_filecoin_pay_contract_address_auct_key" ON "filecoin_pay_fee_auction"("filecoin_pay_contract_address", "auctioned_at_epoch", "tx_position", "call_index");
