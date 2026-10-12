-- Reçu propre au costume quand il est payé seul (sans scolarité) : COS-AAAA-NNNNNN, vérifiable par QR code.
-- Ajout de colonnes uniquement : les versements déjà enregistrés restent tels quels.
ALTER TABLE costume_payments ADD COLUMN IF NOT EXISTS receipt_number TEXT UNIQUE;
ALTER TABLE costume_payments ADD COLUMN IF NOT EXISTS verify_token TEXT UNIQUE;
ALTER TABLE costume_payments ADD COLUMN IF NOT EXISTS snapshot_json TEXT;

-- Un versement de costume ne change pas. Deux évolutions seulement : l'annulation, et le rattachement
-- au nouveau paiement quand le paiement d'origine est corrigé (« Corriger »).
CREATE OR REPLACE FUNCTION costume_payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.student_id, NEW.amount, NEW.paid_on, NEW.method, NEW.received_by, NEW.created_at,
      NEW.receipt_number, NEW.verify_token, NEW.snapshot_json)
     IS NOT DISTINCT FROM
     (OLD.student_id, OLD.amount, OLD.paid_on, OLD.method, OLD.received_by, OLD.created_at,
      OLD.receipt_number, OLD.verify_token, OLD.snapshot_json)
  THEN
    IF OLD.status = 'valide' AND NEW.status = 'annule' AND NEW.payment_id IS NOT DISTINCT FROM OLD.payment_id THEN
      RETURN NEW;
    END IF;
    IF NEW.status = OLD.status AND OLD.status = 'valide' AND OLD.payment_id IS NOT NULL AND NEW.payment_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Un versement de costume ne peut pas être modifié' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
