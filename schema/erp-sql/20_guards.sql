-- Guards and listeners that need the tables: assessments, vouchers, staff exits.

-- A locked or published assessment cannot be reopened or deleted by hand (unlock = approved request, erp.apply_approval).
create or replace function erp.guard_assessment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not erp.is_request_role() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status in ('locked', 'published') and not (pg_trigger_depth() > 1 and not erp.org_exists(old.org_id)) then
      raise exception 'A locked or published assessment cannot be deleted.' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status in ('locked', 'published') and new.status in ('open', 'submitted') then
    raise exception 'Marks are locked after publication. Request an unlock with a reason.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_guard_assessment before update or delete on erp.assessments for each row execute function erp.guard_assessment();

-- A voucher must balance: checked at commit, so the lines can be inserted one by one.
create or replace function erp.check_voucher_balanced() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_d numeric;
  v_c numeric;
begin
  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0) into v_d, v_c
    from erp.voucher_lines l where l.org_id = new.org_id and l.voucher_id = new.voucher_id;
  if v_d <> v_c then
    raise exception 'voucher is not balanced: debit % credit %', v_d, v_c using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger trg_voucher_balanced after insert on erp.voucher_lines
  deferrable initially deferred for each row execute function erp.check_voucher_balanced();

-- Exit and settlement (HR): on notice the staff member is "on_notice"; when settled they have left (core.staff, via this
-- listener: ERP writes only these two columns of core.staff).
create or replace function erp.on_staff_exit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'settled' then
    update core.staff set status = 'left', left_on = coalesce(left_on, new.last_working_day, current_date)
     where id = new.staff_id and org_id = new.org_id and status <> 'left';
  elsif new.status = 'notice' then
    update core.staff set status = 'on_notice' where id = new.staff_id and org_id = new.org_id and status = 'active';
  end if;
  return null;
end $$;
create trigger trg_staff_exit after insert or update of status on erp.staff_exits for each row execute function erp.on_staff_exit();
