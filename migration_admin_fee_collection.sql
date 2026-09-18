-- Adds tracking for the actual M-Pesa STK Push used to collect the 5%
-- monthly admin fee from a laundromat's own phone (previously a stub
-- that never moved any money). Tested idempotent -- safe to re-run on
-- every Railway deploy.
ALTER TABLE admin_fee_invoices ADD COLUMN IF NOT EXISTS checkout_request_id VARCHAR(100) UNIQUE;
CREATE INDEX IF NOT EXISTS idx_admin_fee_checkout ON admin_fee_invoices(checkout_request_id);
