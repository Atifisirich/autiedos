-- Function execute rights. Postgres lets PUBLIC execute every new function: close that for the whole erp schema, then open
-- only what a caller needs. anon gets nothing (the public certificate-verification page goes through the ERP server).
revoke execute on all functions in schema erp from public;

-- helpers evaluated as the caller (column defaults, policies, guard triggers)
grant execute on function erp.my_branch_id(), erp.is_request_role(), erp.org_exists(uuid), erp.my_route_ids(), erp.assessment_status(uuid, uuid)
  to authenticated, erp_server, service_role;

-- functions a signed-in school or portal user may call (each checks the caller inside)
grant execute on function
  erp.collect_fee(jsonb), erp.bounce_cheque(uuid, numeric), erp.create_payment_order(uuid, jsonb),
  erp.apply_approval(uuid), erp.apply_student_exit(uuid, text, date),
  erp.read_student_sensitive(uuid), erp.save_student_sensitive(uuid, jsonb), erp.read_staff_payroll(uuid), erp.save_staff_payroll(uuid, jsonb),
  erp.open_report_card(uuid), erp.log_view(text, uuid, text), erp.setup_org(uuid),
  erp.my_gate_pass_otp(uuid), erp.verify_gate_pass(uuid, text), erp.book_ptm_slot(uuid, uuid),
  erp.get_test_questions(uuid), erp.submit_test(uuid, uuid, jsonb, integer),
  erp.pos_sale(jsonb), erp.wallet_topup(uuid, numeric, text, text),
  erp.driver_routes(), erp.driver_trip_start(uuid, text), erp.driver_trip_students(uuid),
  erp.driver_mark(uuid, uuid, text, numeric, numeric, text), erp.driver_position(uuid, numeric, numeric, numeric), erp.driver_trip_end(uuid)
  to authenticated, erp_server, service_role;

-- server-only: payment gateway callbacks, the CRM hand-off, the public document check
grant execute on function
  erp.settle_payment_order(uuid, text, numeric), erp.fail_payment_order(uuid),
  erp.post_admission_payment(uuid, numeric, text, text, text, text, date, text), erp.verify_document(text)
  to erp_server, service_role;

-- everything else (post_receipts, post_receipt_voucher, reverse_receipt, apply_concession, next_receipt_no, seed_roles,
-- notify_*, route_ok, trigger functions) is internal: reached only from the functions above, which run as the owner.
