-- Barème 2026-2027 par année d'études. Montants de scolarité : l'inscription s'y ajoute
-- (1.000.000 GNF en Bachelor, 3.000.000 GNF en Master).
-- Toutes les écoles : Bachelor 1, 2, 3 = 24, 25, 26 millions ; Master 1, 2 = 27, 28 millions.
-- Africaiim Tech : 35 millions pour chaque année de Bachelor, 45 millions en Master 1 et 2.
-- Découpe 20 / 40 / 40 comme officialInstallments. L'ancienne ligne reste dans fee_schedule_history.

INSERT INTO fee_schedule_history(fee_schedule_id, snapshot_json, changed_by)
SELECT f.id, row_to_json(f)::text, NULL
FROM fee_schedules f
JOIN programs p ON p.id = f.program_id
JOIN academic_years y ON y.id = f.academic_year_id
JOIN (VALUES
  ('bachelor', 24000000, 35000000),
  ('bachelor_1', 24000000, 35000000),
  ('bachelor_2', 25000000, 35000000),
  ('bachelor_3', 26000000, 35000000),
  ('master_1', 27000000, 45000000),
  ('master_2', 28000000, 45000000)
) AS g(level, autres, tech) ON g.level = f.level
WHERE y.label = '2026-2027'
  AND f.tuition_amount <> CASE WHEN p.code = 'TECH' THEN g.tech ELSE g.autres END;

UPDATE fee_schedules f
SET tuition_amount = n.montant,
    registration_amount = (n.montant * 20 + 50) / 100,
    installment_1 = (n.montant * 40 + 50) / 100,
    installment_2 = n.montant - (n.montant * 20 + 50) / 100 - (n.montant * 40 + 50) / 100,
    installment_3 = 0
FROM (
  SELECT f2.id, (CASE WHEN p.code = 'TECH' THEN g.tech ELSE g.autres END)::bigint AS montant
  FROM fee_schedules f2
  JOIN programs p ON p.id = f2.program_id
  JOIN academic_years y ON y.id = f2.academic_year_id
  JOIN (VALUES
    ('bachelor', 24000000, 35000000),
    ('bachelor_1', 24000000, 35000000),
    ('bachelor_2', 25000000, 35000000),
    ('bachelor_3', 26000000, 35000000),
    ('master_1', 27000000, 45000000),
    ('master_2', 28000000, 45000000)
  ) AS g(level, autres, tech) ON g.level = f2.level
  WHERE y.label = '2026-2027'
) n
WHERE f.id = n.id AND f.tuition_amount <> n.montant;
