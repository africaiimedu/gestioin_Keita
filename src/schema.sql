-- AfricaIIM Scolarité
-- Montants en entiers (francs guinéens). Aucune colonne « total payé » ou « reste »
-- n'est stockée comme vérité : ces chiffres sont toujours recalculés.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_required INTEGER NOT NULL DEFAULT 0 CHECK (totp_required IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  permissions_json TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  email TEXT,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS academic_years (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fee_schedules (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  level TEXT NOT NULL CHECK (level IN ('licence', 'master', 'tech', 'bachelor', 'bachelor_1', 'bachelor_2', 'bachelor_3', 'master_1', 'master_2')),
  tuition_amount INTEGER NOT NULL CHECK (tuition_amount > 0),
  registration_amount INTEGER NOT NULL CHECK (registration_amount >= 0),
  installment_1 INTEGER NOT NULL CHECK (installment_1 >= 0),
  installment_2 INTEGER NOT NULL CHECK (installment_2 >= 0),
  installment_3 INTEGER NOT NULL CHECK (installment_3 >= 0),
  -- 1 = le droit d'inscription est déjà compris dans tuition_amount (hypothèse actuelle)
  registration_included INTEGER NOT NULL DEFAULT 1 CHECK (registration_included IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (program_id, academic_year_id, level),
  CHECK (registration_amount + installment_1 + installment_2 + installment_3 = tuition_amount)
);

CREATE TABLE IF NOT EXISTS fee_schedule_history (
  id INTEGER PRIMARY KEY,
  fee_schedule_id INTEGER NOT NULL REFERENCES fee_schedules(id),
  snapshot_json TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS installment_due_dates (
  id INTEGER PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  code TEXT NOT NULL CHECK (code IN ('inscription', 'tranche_1', 'tranche_2', 'tranche_3')),
  due_on TEXT NOT NULL,
  UNIQUE (academic_year_id, code)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  matricule TEXT NOT NULL UNIQUE,
  legacy_number INTEGER,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  level TEXT NOT NULL CHECK (level IN ('licence', 'master', 'tech', 'bachelor', 'bachelor_1', 'bachelor_2', 'bachelor_3', 'master_1', 'master_2')),
  phone TEXT,
  email TEXT,
  guardian_name TEXT,
  guardian_phone TEXT,
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'suspendu', 'archive')),
  photo_path TEXT,
  card_status TEXT NOT NULL DEFAULT 'active' CHECK (card_status IN ('active', 'limited', 'suspended')),
  source TEXT NOT NULL DEFAULT 'saisie' CHECK (source IN ('pdf', 'saisie', 'demo')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  label TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('fixe', 'pourcentage')),
  value INTEGER NOT NULL CHECK (value > 0),
  reason TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS student_installments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  code TEXT NOT NULL CHECK (code IN ('inscription', 'tranche_1', 'tranche_2', 'tranche_3')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  due_on TEXT,
  UNIQUE (student_id, code)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_on TEXT NOT NULL,
  date_unconfirmed INTEGER NOT NULL DEFAULT 0 CHECK (date_unconfirmed IN (0, 1)),
  method TEXT NOT NULL CHECK (method IN ('especes', 'cheque', 'virement', 'mobile', 'orange_money', 'marchand', 'autre')),
  reference TEXT,
  installment_code TEXT CHECK (installment_code IS NULL OR installment_code IN ('inscription', 'tranche_1', 'tranche_2', 'tranche_3')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide', 'annule')),
  idempotency_key TEXT NOT NULL UNIQUE,
  received_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_controls (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id),
  updates_used INTEGER NOT NULL DEFAULT 0,
  cancel_used INTEGER NOT NULL DEFAULT 0,
  unlocked INTEGER NOT NULL DEFAULT 0
);

-- Costume : suivi à part de la scolarité. Un versement lié à un paiement suit l'état de ce paiement.
CREATE TABLE IF NOT EXISTS costume_payments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  payment_id INTEGER REFERENCES payments(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_on TEXT NOT NULL,
  method TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide', 'annule')),
  cancel_reason TEXT,
  received_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_attachments (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_sequences (
  kind TEXT NOT NULL,
  year INTEGER NOT NULL,
  last_number INTEGER NOT NULL,
  PRIMARY KEY (kind, year)
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
  number TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  verify_token TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL,
  print_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (year, seq)
);

CREATE TABLE IF NOT EXISTS enrollment_receipts (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL UNIQUE REFERENCES students(id),
  number TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  verify_token TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL,
  print_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (year, seq)
);

CREATE TABLE IF NOT EXISTS cancellations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
  reason TEXT NOT NULL,
  cancelled_by INTEGER NOT NULL REFERENCES users(id),
  cancelled_at TEXT NOT NULL DEFAULT (datetime('now')),
  credit_note_number TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  filename TEXT,
  status TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON payments(paid_on);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_students_name ON students(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_costume_student ON costume_payments(student_id);

INSERT OR IGNORE INTO settings(key, value) VALUES('costume_price', '0');

CREATE TRIGGER IF NOT EXISTS costume_payments_immutable
BEFORE UPDATE ON costume_payments
FOR EACH ROW
WHEN NOT (
  OLD.status = 'valide'
  AND NEW.status = 'annule'
  AND OLD.amount = NEW.amount
  AND OLD.student_id = NEW.student_id
  AND IFNULL(OLD.payment_id, 0) = IFNULL(NEW.payment_id, 0)
  AND OLD.paid_on = NEW.paid_on
)
BEGIN
  SELECT RAISE(ABORT, 'Un versement de costume ne peut pas être modifié');
END;

CREATE TRIGGER IF NOT EXISTS costume_payments_no_delete
BEFORE DELETE ON costume_payments
BEGIN
  SELECT RAISE(ABORT, 'Un versement de costume ne peut pas être supprimé');
END;

-- Un paiement validé ne change pas. Seul le passage à « annulé » est permis.
CREATE TRIGGER IF NOT EXISTS payments_immutable
BEFORE UPDATE ON payments
FOR EACH ROW
WHEN NOT (
  OLD.status = 'valide'
  AND NEW.status = 'annule'
  AND OLD.amount = NEW.amount
  AND OLD.student_id = NEW.student_id
  AND OLD.paid_on = NEW.paid_on
  AND OLD.method = NEW.method
  AND IFNULL(OLD.reference, '') = IFNULL(NEW.reference, '')
  AND IFNULL(OLD.installment_code, '') = IFNULL(NEW.installment_code, '')
  AND OLD.idempotency_key = NEW.idempotency_key
  AND OLD.received_by = NEW.received_by
  AND OLD.date_unconfirmed = NEW.date_unconfirmed
)
BEGIN
  SELECT RAISE(ABORT, 'Un paiement validé ne peut pas être modifié');
END;

CREATE TRIGGER IF NOT EXISTS payments_no_delete
BEFORE DELETE ON payments
BEGIN
  SELECT RAISE(ABORT, 'Un paiement ne peut pas être supprimé');
END;

CREATE TRIGGER IF NOT EXISTS receipts_immutable
BEFORE UPDATE ON receipts
FOR EACH ROW
WHEN OLD.number != NEW.number
  OR OLD.seq != NEW.seq
  OR OLD.year != NEW.year
  OR OLD.payment_id != NEW.payment_id
  OR OLD.snapshot_json != NEW.snapshot_json
  OR OLD.verify_token != NEW.verify_token
BEGIN
  SELECT RAISE(ABORT, 'Un numéro de reçu ne peut pas être modifié');
END;

CREATE TRIGGER IF NOT EXISTS enrollment_receipts_immutable
BEFORE UPDATE ON enrollment_receipts
FOR EACH ROW
WHEN OLD.number != NEW.number
  OR OLD.seq != NEW.seq
  OR OLD.year != NEW.year
  OR OLD.student_id != NEW.student_id
  OR OLD.snapshot_json != NEW.snapshot_json
  OR OLD.verify_token != NEW.verify_token
BEGIN
  SELECT RAISE(ABORT, 'Un reçu d''inscription ne peut pas être modifié');
END;

CREATE TRIGGER IF NOT EXISTS enrollment_receipts_no_delete
BEFORE DELETE ON enrollment_receipts
BEGIN
  SELECT RAISE(ABORT, 'Un reçu d''inscription ne peut pas être supprimé');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Le journal d''audit est immuable');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Le journal d''audit est immuable');
END;
