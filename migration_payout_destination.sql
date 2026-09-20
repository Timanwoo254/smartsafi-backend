-- Laundromat payout destination, captured at registration and verified by an
-- admin before the business can be approved.
--
-- Why payout_method matters: M-Pesa uses TWO different APIs depending on where
-- money is going. B2C pays an individual's phone wallet (PartyB = MSISDN).
-- B2B pays another business's till or paybill (PartyB = shortcode). Sending a
-- till number through the B2C endpoint fails, so the method must be stored and
-- the correct API chosen at payout time.
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS payout_method VARCHAR(20)
  CHECK (payout_method IN ('mpesa_phone','till','paybill'));
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS payout_number VARCHAR(30);
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS payout_account_ref VARCHAR(50);
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS payout_name VARCHAR(120);
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS payout_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS payout_verified_at TIMESTAMP;
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS payout_verified_by UUID;

-- Backfill: existing rows that only had mpesa_till become till-method payouts,
-- but stay UNVERIFIED so an admin still has to confirm them.
UPDATE laundromats
   SET payout_method='till', payout_number=mpesa_till
 WHERE payout_method IS NULL AND mpesa_till IS NOT NULL AND mpesa_till <> '';

CREATE INDEX IF NOT EXISTS idx_laundromats_payout_verified ON laundromats(payout_verified);
