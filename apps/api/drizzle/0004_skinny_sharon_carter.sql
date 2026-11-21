-- Convert existing records atomically. Request UUIDs and command keys are not record identifiers.
CREATE SEQUENCE record_id_seq AS integer START WITH 10000;
CREATE TEMP TABLE record_id_map(old_id uuid PRIMARY KEY,new_id integer UNIQUE NOT NULL) ON COMMIT DROP;
INSERT INTO record_id_map SELECT old_id, CASE WHEN old_id::text ~ '^00000002-0000-4000-8000-[0-9]{12}$' THEN 1000+right(old_id::text,12)::integer ELSE nextval('record_id_seq')::integer END FROM (
SELECT id AS old_id FROM users
UNION ALL
SELECT id AS old_id FROM sessions
UNION ALL
SELECT id AS old_id FROM audit_logs
UNION ALL
SELECT id AS old_id FROM idempotency_records
UNION ALL
SELECT id AS old_id FROM outbox_jobs
UNION ALL
SELECT id AS old_id FROM pricing_groups
UNION ALL
SELECT id AS old_id FROM vehicle_brands
UNION ALL
SELECT id AS old_id FROM vehicle_models
UNION ALL
SELECT id AS old_id FROM equivalence_groups
UNION ALL
SELECT id AS old_id FROM customers
UNION ALL
SELECT id AS old_id FROM customer_notes
UNION ALL
SELECT id AS old_id FROM vehicles
UNION ALL
SELECT id AS old_id FROM vehicle_service_records
) records ORDER BY old_id;
CREATE FUNCTION pg_temp.numeric_id(value uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE found_id integer;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 SELECT new_id INTO STRICT found_id FROM record_id_map WHERE old_id=value;
 RETURN found_id;
END $$;
CREATE FUNCTION pg_temp.remap_record_json(value jsonb,field_name text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb; item record; mapped integer;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN
   result='{}'::jsonb;
   FOR item IN SELECT key,val FROM jsonb_each(value) AS e(key,val) LOOP
     result=result||jsonb_build_object(item.key,pg_temp.remap_record_json(item.val,item.key));
   END LOOP;
 WHEN 'array' THEN
   SELECT coalesce(jsonb_agg(pg_temp.remap_record_json(v,field_name) ORDER BY n),'[]'::jsonb) INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS e(v,n);
 WHEN 'string' THEN
   result=value;
   IF field_name ~ '(^id$|_id$|Id$|Ids$)' AND (value#>>'{}') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
     SELECT new_id INTO mapped FROM record_id_map WHERE old_id=(value#>>'{}')::uuid;
     IF FOUND THEN result=to_jsonb(mapped); END IF;
   END IF;
 ELSE result=value;
 END CASE;
 RETURN result;
END $$;
CREATE TEMP TABLE record_fk_restore(table_name text,constraint_name text,definition text) ON COMMIT DROP;
INSERT INTO record_fk_restore SELECT c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace;
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT * FROM record_fk_restore LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.table_name,item.constraint_name); END LOOP;
 FOR item IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND data_type='uuid' AND column_name<>'request_id' LOOP
   EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT',item.table_name,item.column_name);
   EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE integer USING pg_temp.numeric_id(%I)',item.table_name,item.column_name,item.column_name);
   IF item.column_name='id' THEN EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DEFAULT nextval(''record_id_seq'')',item.table_name); END IF;
 END LOOP;
 FOR item IN SELECT * FROM record_fk_restore LOOP EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item.table_name,item.constraint_name,item.definition); END LOOP;
END $$;
UPDATE audit_logs SET details=pg_temp.remap_record_json(details);
UPDATE idempotency_records SET result=pg_temp.remap_record_json(result);
UPDATE outbox_jobs SET payload=pg_temp.remap_record_json(payload);
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT * FROM record_id_map LOOP
   UPDATE outbox_jobs SET business_key=replace(business_key,item.old_id::text,item.new_id::text) WHERE strpos(business_key,item.old_id::text)>0;
 END LOOP;
END $$;
-- Abort instead of committing broken foreign keys or an unmapped audit entity.
