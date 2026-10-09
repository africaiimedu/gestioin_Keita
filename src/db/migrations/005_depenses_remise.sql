-- Remise de l'argent : une décharge est d'abord « à remettre », puis marquée « remise » une seule fois.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS handed_at TIMESTAMP(0);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS handed_by INTEGER REFERENCES users(id);

CREATE OR REPLACE FUNCTION expenses_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.number, NEW.year, NEW.seq, NEW.issued_on, NEW.city, NEW.receiver_name, NEW.receiver_position,
      NEW.giver_name, NEW.amount, NEW.reason, NEW.category, NEW.verify_token, NEW.created_by, NEW.created_at)
     IS NOT DISTINCT FROM
     (OLD.id, OLD.number, OLD.year, OLD.seq, OLD.issued_on, OLD.city, OLD.receiver_name, OLD.receiver_position,
      OLD.giver_name, OLD.amount, OLD.reason, OLD.category, OLD.verify_token, OLD.created_by, OLD.created_at)
     AND (NEW.status = OLD.status OR (OLD.status = 'valide' AND NEW.status = 'annule'))
     AND ((NEW.handed_at IS NOT DISTINCT FROM OLD.handed_at AND NEW.handed_by IS NOT DISTINCT FROM OLD.handed_by)
          OR (OLD.handed_at IS NULL AND OLD.status = 'valide' AND NEW.handed_at IS NOT NULL AND NEW.handed_by IS NOT NULL))
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Une décharge enregistrée ne peut pas être modifiée' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
