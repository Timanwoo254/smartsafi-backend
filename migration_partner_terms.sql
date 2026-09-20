-- Records that a partner accepted the terms at registration, and WHICH version
-- they accepted. Version matters: when terms change you need to know who is
-- still on an older set, and consent to a superseded document is not consent
-- to the current one.
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP;
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20);
ALTER TABLE laundromats ADD COLUMN IF NOT EXISTS terms_accepted_ip VARCHAR(60);
CREATE INDEX IF NOT EXISTS idx_laundromats_terms_version ON laundromats(terms_version);
