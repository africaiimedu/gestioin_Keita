-- AfricaIIM Scolarité — schéma PostgreSQL.
-- Montants en francs guinéens entiers (BIGINT). Aucun « total payé » ni « reste » n'est stocké :
-- ces chiffres sont toujours recalculés à partir des paiements.
-- Horodatages en UTC, sans fuseau, au format « AAAA-MM-JJ HH:MM:SS ».
-- Compatible PostgreSQL 9.6 et suivants (hébergement o2switch).

CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_required SMALLINT NOT NULL DEFAULT 0 CHECK (totp_required IN (0, 1)),
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  permissions_json TEXT CHECK (jsonb_typeof(permissions_json::jsonb) = 'array'),
  must_change_password SMALLINT NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX idx_users_role ON users(role_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE login_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  email TEXT,
  success SMALLINT NOT NULL CHECK (success IN (0, 1)),
  ip TEXT,
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX idx_login_logs_created ON login_logs(created_at);

CREATE TABLE academic_years (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  active SMALLINT NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  CHECK (ends_on > starts_on)
);
-- Une seule année active à la fois.
CREATE UNIQUE INDEX uq_academic_years_active ON academic_years(active) WHERE active = 1;

CREATE TABLE programs (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE fee_schedules (
  id SERIAL PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  level TEXT NOT NULL CHECK (level IN ('licence', 'master', 'tech', 'bachelor', 'bachelor_1', 'bachelor_2', 'bachelor_3', 'master_1', 'master_2')),
  tuition_amount BIGINT NOT NULL CHECK (tuition_amount > 0),
  registration_amount BIGINT NOT NULL CHECK (registration_amount >= 0),
  installment_1 BIGINT NOT NULL CHECK (installment_1 >= 0),
  installment_2 BIGINT NOT NULL CHECK (installment_2 >= 0),
  installment_3 BIGINT NOT NULL CHECK (installment_3 >= 0),
  registration_included SMALLINT NOT NULL DEFAULT 1 CHECK (registration_included IN (0, 1)),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  UNIQUE (program_id, academic_year_id, level),
  CHECK (registration_amount + installment_1 + installment_2 + installment_3 = tuition_amount)
);
CREATE INDEX idx_fee_schedules_year ON fee_schedules(academic_year_id);

CREATE TABLE fee_schedule_history (
  id SERIAL PRIMARY KEY,
  fee_schedule_id INTEGER NOT NULL REFERENCES fee_schedules(id),
  snapshot_json TEXT NOT NULL CHECK (snapshot_json::jsonb IS NOT NULL OR snapshot_json IS NULL),
  changed_by INTEGER REFERENCES users(id),
  changed_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX idx_fee_history_schedule ON fee_schedule_history(fee_schedule_id);

CREATE TABLE installment_due_dates (
  id SERIAL PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  code TEXT NOT NULL CHECK (code IN ('inscription', 'tranche_1', 'tranche_2', 'tranche_3')),
  due_on DATE NOT NULL,
  UNIQUE (academic_year_id, code)
);

CREATE TABLE students (
  id SERIAL PRIMARY KEY,
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
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX idx_students_name ON students(last_name, first_name);
CREATE INDEX idx_students_year ON students(academic_year_id, program_id);

CREATE TABLE discounts (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  label TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('fixe', 'pourcentage')),
  value BIGINT NOT NULL CHECK (value > 0),
  reason TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  CHECK (mode <> 'pourcentage' OR value <= 100)
);
CREATE INDEX idx_discounts_student ON discounts(student_id);

CREATE TABLE adjustments (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount BIGINT NOT NULL CHECK (amount <> 0),
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX idx_adjustments_student ON adjustments(student_id);

CREATE TABLE student_installments (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  code TEXT NOT NULL CHECK (code IN ('inscription', 'tranche_1', 'tranche_2', 'tranche_3')),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  due_on DATE,
  UNIQUE (student_id, code)
);

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  paid_on DATE NOT NULL,
  date_unconfirmed SMALLINT NOT NULL DEFAULT 0 CHECK (date_unconfirmed IN (0, 1)),
  method TEXT NOT NULL CHECK (method IN ('especes', 'cheque', 'virement', 'mobile', 'orange_money', 'marchand', 'autre')),
  reference TEXT,
  installment_code TEXT CHECK (installment_code IS NULL OR installment_code IN ('inscription', 'tranche_1', 'tranche_2', 'tranche_3')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide', 'annule')),
  idempotency_key TEXT NOT NULL UNIQUE,
  received_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX idx_payments_student ON payments(student_id);
CREATE INDEX idx_payments_paid_on ON payments(paid_on);
CREATE INDEX idx_payments_reference ON payments(reference) WHERE reference IS NOT NULL;
CREATE INDEX idx_payments_received_by ON payments(received_by);

CREATE TABLE payment_controls (
  payment_id INTEGER PRIMARY KEY REFERENCES payments(id),
  updates_used INTEGER NOT NULL DEFAULT 0 CHECK (updates_used >= 0),
  cancel_used INTEGER NOT NULL DEFAULT 0 CHECK (cancel_used IN (0, 1)),
  unlocked SMALLINT NOT NULL DEFAULT 0 CHECK (unlocked IN (0, 1))
);

-- Costume : suivi à part de la scolarité. Un versement lié à un paiement suit l'état de ce paiement.
CREATE TABLE costume_payments (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  payment_id INTEGER REFERENCES payments(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  paid_on DATE NOT NULL,
  method TEXT CHECK (method IS NULL OR method IN ('especes', 'cheque', 'virement', 'mobile', 'orange_money', 'marchand', 'autre')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide', 'annule')),
  cancel_reason TEXT,
  received_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  CHECK (status = 'valide' OR cancel_reason IS NOT NULL)
);
CREATE INDEX idx_costume_student ON costume_payments(student_id);
CREATE INDEX idx_costume_payment ON costume_payments(payment_id) WHERE payment_id IS NOT NULL;

CREATE TABLE payment_attachments (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime TEXT,
  uploaded_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX idx_attachments_payment ON payment_attachments(payment_id);

CREATE TABLE document_sequences (
  kind TEXT NOT NULL,
  year INTEGER NOT NULL,
  last_number INTEGER NOT NULL CHECK (last_number >= 0),
  PRIMARY KEY (kind, year)
);

CREATE TABLE receipts (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
  number TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  verify_token TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL CHECK (jsonb_typeof(snapshot_json::jsonb) = 'object'),
  print_count INTEGER NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  UNIQUE (year, seq)
);

CREATE TABLE enrollment_receipts (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL UNIQUE REFERENCES students(id),
  number TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  verify_token TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL CHECK (jsonb_typeof(snapshot_json::jsonb) = 'object'),
  print_count INTEGER NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  UNIQUE (year, seq)
);

CREATE TABLE cancellations (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
  reason TEXT NOT NULL,
  cancelled_by INTEGER NOT NULL REFERENCES users(id),
  cancelled_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  credit_note_number TEXT UNIQUE
);

CREATE TABLE reminders (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX idx_reminders_student ON reminders(student_id);

-- Pas de clé étrangère : une ligne d'audit doit pouvoir être écrite en toutes circonstances.
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT CHECK (before_json::jsonb IS NOT NULL OR before_json IS NULL),
  after_json TEXT CHECK (after_json::jsonb IS NOT NULL OR after_json IS NULL),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);

CREATE TABLE import_batches (
  id SERIAL PRIMARY KEY,
  filename TEXT,
  status TEXT NOT NULL CHECK (status IN ('apercu', 'importe')),
  report_json TEXT NOT NULL CHECK (jsonb_typeof(report_json::jsonb) = 'object'),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings(key, value) VALUES ('costume_price', '0') ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Registre infalsifiable : ce qui est encaissé, imprimé ou journalisé ne change plus.
-- ---------------------------------------------------------------------------

CREATE FUNCTION refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- Un paiement validé ne change pas. Seul le passage à « annulé » est permis.
CREATE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'valide' AND NEW.status = 'annule'
     AND (NEW.student_id, NEW.amount, NEW.paid_on, NEW.date_unconfirmed, NEW.method, NEW.reference,
          NEW.installment_code, NEW.note, NEW.idempotency_key, NEW.received_by, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.student_id, OLD.amount, OLD.paid_on, OLD.date_unconfirmed, OLD.method, OLD.reference,
          OLD.installment_code, OLD.note, OLD.idempotency_key, OLD.received_by, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Un paiement validé ne peut pas être modifié' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION costume_payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'valide' AND NEW.status = 'annule'
     AND (NEW.student_id, NEW.payment_id, NEW.amount, NEW.paid_on, NEW.method, NEW.received_by, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.student_id, OLD.payment_id, OLD.amount, OLD.paid_on, OLD.method, OLD.received_by, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Un versement de costume ne peut pas être modifié' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- Sur un reçu, seul le compteur d'impressions évolue.
CREATE FUNCTION receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.payment_id, NEW.number, NEW.year, NEW.seq, NEW.verify_token, NEW.snapshot_json, NEW.created_at)
     IS NOT DISTINCT FROM
     (OLD.id, OLD.payment_id, OLD.number, OLD.year, OLD.seq, OLD.verify_token, OLD.snapshot_json, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Un numéro de reçu ne peut pas être modifié' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION enrollment_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.student_id, NEW.number, NEW.year, NEW.seq, NEW.verify_token, NEW.snapshot_json, NEW.created_at)
     IS NOT DISTINCT FROM
     (OLD.id, OLD.student_id, OLD.number, OLD.year, OLD.seq, OLD.verify_token, OLD.snapshot_json, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Un reçu d''inscription ne peut pas être modifié' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER payments_immutable BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE PROCEDURE payments_guard();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE PROCEDURE refuse_change('Un paiement ne peut pas être supprimé');
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments
  FOR EACH STATEMENT EXECUTE PROCEDURE refuse_change('Un paiement ne peut pas être supprimé');

CREATE TRIGGER costume_payments_immutable BEFORE UPDATE ON costume_payments
  FOR EACH ROW EXECUTE PROCEDURE costume_payments_guard();
CREATE TRIGGER costume_payments_no_delete BEFORE DELETE ON costume_payments
  FOR EACH ROW EXECUTE PROCEDURE refuse_change('Un versement de costume ne peut pas être supprimé');
CREATE TRIGGER costume_payments_no_truncate BEFORE TRUNCATE ON costume_payments
  FOR EACH STATEMENT EXECUTE PROCEDURE refuse_change('Un versement de costume ne peut pas être supprimé');

CREATE TRIGGER receipts_immutable BEFORE UPDATE ON receipts
  FOR EACH ROW EXECUTE PROCEDURE receipts_guard();
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts
  FOR EACH ROW EXECUTE PROCEDURE refuse_change('Un reçu ne peut pas être supprimé');
CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON receipts
  FOR EACH STATEMENT EXECUTE PROCEDURE refuse_change('Un reçu ne peut pas être supprimé');

CREATE TRIGGER enrollment_receipts_immutable BEFORE UPDATE ON enrollment_receipts
  FOR EACH ROW EXECUTE PROCEDURE enrollment_receipts_guard();
CREATE TRIGGER enrollment_receipts_no_delete BEFORE DELETE ON enrollment_receipts
  FOR EACH ROW EXECUTE PROCEDURE refuse_change('Un reçu d''inscription ne peut pas être supprimé');
CREATE TRIGGER enrollment_receipts_no_truncate BEFORE TRUNCATE ON enrollment_receipts
  FOR EACH STATEMENT EXECUTE PROCEDURE refuse_change('Un reçu d''inscription ne peut pas être supprimé');

CREATE TRIGGER cancellations_no_update BEFORE UPDATE ON cancellations
  FOR EACH ROW EXECUTE PROCEDURE refuse_change('Une annulation ne peut pas être modifiée');
CREATE TRIGGER cancellations_no_delete BEFORE DELETE ON cancellations
  FOR EACH ROW EXECUTE PROCEDURE refuse_change('Une annulation ne peut pas être supprimée');
CREATE TRIGGER cancellations_no_truncate BEFORE TRUNCATE ON cancellations
  FOR EACH STATEMENT EXECUTE PROCEDURE refuse_change('Une annulation ne peut pas être supprimée');

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE PROCEDURE refuse_change('Le journal d''audit est immuable');
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE PROCEDURE refuse_change('Le journal d''audit est immuable');
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE PROCEDURE refuse_change('Le journal d''audit est immuable');
