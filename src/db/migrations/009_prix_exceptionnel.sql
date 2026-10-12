-- Prix annuel fixé à la main pour un étudiant (scolarité + inscription), sans remise « Paiement comptant ».
ALTER TABLE students ADD COLUMN IF NOT EXISTS custom_fee BIGINT CHECK (custom_fee IS NULL OR custom_fee >= 0);
ALTER TABLE students ADD COLUMN IF NOT EXISTS custom_fee_reason TEXT;
