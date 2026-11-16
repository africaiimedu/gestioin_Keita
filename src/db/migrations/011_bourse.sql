-- Montant total de la bourse, informatif : jamais un paiement ni une remise.
ALTER TABLE students ADD COLUMN IF NOT EXISTS scholarship_amount BIGINT NOT NULL DEFAULT 0;
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_scholarship_amount_check;
ALTER TABLE students ADD CONSTRAINT students_scholarship_amount_check CHECK (scholarship_amount >= 0);
