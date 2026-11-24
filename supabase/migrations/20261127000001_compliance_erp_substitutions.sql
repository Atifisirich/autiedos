-- Register erp.substitutions (added by the ERP staff screens, 20261118100002) in the compliance registry,
-- exactly like os.substitutions in 20261126000001_compliance_products.sql: a work record kept on the pseudonymous staff row.
insert into core.pii_registry (schema_name, table_name, person_type, key_column, contact_columns, is_subject, link_columns,
                               pii_columns, audit_columns, anonymise_values, erasure_mode, retain_reason, erase_order, note)
values
  ('erp', 'substitutions', 'staff', 'absent_staff_id', '{}', false, '{}', array['absent_staff_id'], '{}', '{}', 'retain',
   'Work record made in the course of employment (planning, teaching, duties, timetable); the staff row is pseudonymous (retention schedule 2.1 operational records, CONFIRM).',
   100, 'Substitutions for the staff member.'),
  ('erp', 'substitutions', 'staff', 'substitute_staff_id', '{}', false, '{}', array['substitute_staff_id'], '{}', '{}', 'retain',
   'Work record made in the course of employment (planning, teaching, duties, timetable); the staff row is pseudonymous (retention schedule 2.1 operational records, CONFIRM).',
   100, 'Substitutions taken by the staff member.');
