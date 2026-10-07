-- Compatibilité PostgreSQL 10+ (hébergement o2switch) : les contrôles JSON passent par jsonb
-- au lieu de « IS JSON » (PostgreSQL 16). Les bases créées avec l'ancienne écriture sont mises à niveau ici.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_permissions_json_check;
ALTER TABLE users ADD CONSTRAINT users_permissions_json_check
  CHECK (jsonb_typeof(permissions_json::jsonb) = 'array');

ALTER TABLE fee_schedule_history DROP CONSTRAINT IF EXISTS fee_schedule_history_snapshot_json_check;
ALTER TABLE fee_schedule_history ADD CONSTRAINT fee_schedule_history_snapshot_json_check
  CHECK (snapshot_json::jsonb IS NOT NULL OR snapshot_json IS NULL);

ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_snapshot_json_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_snapshot_json_check
  CHECK (jsonb_typeof(snapshot_json::jsonb) = 'object');

ALTER TABLE enrollment_receipts DROP CONSTRAINT IF EXISTS enrollment_receipts_snapshot_json_check;
ALTER TABLE enrollment_receipts ADD CONSTRAINT enrollment_receipts_snapshot_json_check
  CHECK (jsonb_typeof(snapshot_json::jsonb) = 'object');

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_before_json_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_before_json_check
  CHECK (before_json::jsonb IS NOT NULL OR before_json IS NULL);

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_after_json_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_after_json_check
  CHECK (after_json::jsonb IS NOT NULL OR after_json IS NULL);

ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_report_json_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_report_json_check
  CHECK (jsonb_typeof(report_json::jsonb) = 'object');

-- Limitation des tentatives de connexion calculée en base : partagée entre tous les processus Node.
CREATE INDEX IF NOT EXISTS idx_login_logs_email_created ON login_logs(email, created_at);
