-- Mohamed Keita doit voir la cantine et la gestion cuisine.
UPDATE users
SET permissions_json = (permissions_json::jsonb || '["kitchen.manage"]'::jsonb)::text
WHERE lower(email) = 'mohamed.keita@univ-africaiim.com'
  AND active = 1
  AND permissions_json IS NOT NULL
  AND jsonb_typeof(permissions_json::jsonb) = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(permissions_json::jsonb) AS droit(code)
    WHERE droit.code = 'kitchen.manage'
  );
