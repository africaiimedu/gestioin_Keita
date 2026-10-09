-- Plusieurs costumes par étudiant : le montant dû est le nombre de costumes × le prix unitaire.
ALTER TABLE students ADD COLUMN IF NOT EXISTS costume_quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_costume_quantity_check;
ALTER TABLE students ADD CONSTRAINT students_costume_quantity_check CHECK (costume_quantity BETWEEN 1 AND 20);

-- Dépenses : chaque sortie d'argent est une décharge de responsabilité financière numérotée.
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  issued_on DATE NOT NULL,
  city TEXT NOT NULL,
  receiver_name TEXT NOT NULL,
  receiver_position TEXT NOT NULL,
  giver_name TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'autre',
  status TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide', 'annule')),
  cancel_reason TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TIMESTAMP(0),
  verify_token TEXT NOT NULL UNIQUE,
  print_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE INDEX IF NOT EXISTS idx_expenses_issued ON expenses(issued_on);

-- Une décharge signée ne change plus : seuls l'annulation et le compteur d'impressions évoluent.
CREATE OR REPLACE FUNCTION expenses_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.number, NEW.year, NEW.seq, NEW.issued_on, NEW.city, NEW.receiver_name, NEW.receiver_position,
      NEW.giver_name, NEW.amount, NEW.reason, NEW.category, NEW.verify_token, NEW.created_by, NEW.created_at)
     IS NOT DISTINCT FROM
     (OLD.id, OLD.number, OLD.year, OLD.seq, OLD.issued_on, OLD.city, OLD.receiver_name, OLD.receiver_position,
      OLD.giver_name, OLD.amount, OLD.reason, OLD.category, OLD.verify_token, OLD.created_by, OLD.created_at)
     AND (NEW.status = OLD.status OR (OLD.status = 'valide' AND NEW.status = 'annule'))
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Une décharge enregistrée ne peut pas être modifiée' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS expenses_immutable ON expenses;
CREATE TRIGGER expenses_immutable BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE PROCEDURE expenses_guard();
DROP TRIGGER IF EXISTS expenses_no_delete ON expenses;
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE PROCEDURE refuse_change('Une décharge ne peut pas être supprimée');
DROP TRIGGER IF EXISTS expenses_no_truncate ON expenses;
CREATE TRIGGER expenses_no_truncate BEFORE TRUNCATE ON expenses
  FOR EACH STATEMENT EXECUTE PROCEDURE refuse_change('Une décharge ne peut pas être supprimée');
