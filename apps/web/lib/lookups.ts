'use client';
import { useEffect, useState } from 'react';
import { get } from './api';

export interface Lookups {
  staff: { id: string; full_name: string; department_id: string | null; wing_id: string | null; branch_id: string | null; is_teaching: boolean }[];
  sections: { id: string; name: string; class_id: string; wing_id: string }[];
  classes: { id: string; name: string; wing_id: string; grade_level: number }[];
  subjects: { id: string; name: string; code: string; content_language: string; department_id: string | null; curriculum_subject_id: string | null }[];
  wings: { id: string; name: string; board: string }[];
  departments: { id: string; name: string }[];
  rooms: { id: string; name: string; room_type: string; capacity: number; qr_token: string }[];
  roles: { id: string; key: string; name: string }[];
  positions: { id: string; key: string; name: string }[];
  task_categories: { id: string; key: string; name: string; name_i18n: Record<string, string>; color: string; default_proof: string; default_verification: boolean }[];
  leave_types: { id: string; key: string; name: string; name_i18n: Record<string, string>; unit: string; half_day_allowed: boolean }[];
  ticket_categories: { id: string; key: string; name: string; name_i18n: Record<string, string> }[];
  exam_types: { id: string; key: string; name: string; name_i18n: Record<string, string> }[];
  event_templates: { id: string; key: string; name: string; name_i18n: Record<string, string> }[];
  approval_types: { id: string; key: string; name: string; name_i18n: Record<string, string>; form_schema: { key: string; label: string; type: string; required: boolean; options?: string[] }[]; is_system: boolean }[];
  appraisal_cycles: { id: string; name: string; released: boolean }[];
}

let cache: Promise<Lookups> | null = null;

/** Dropdown data for forms, loaded once per page load. */
export function useLookups(): Lookups | null {
  const [data, setData] = useState<Lookups | null>(null);
  useEffect(() => {
    cache ??= get<Lookups>('/lookups');
    cache.then(setData).catch(() => (cache = null));
  }, []);
  return data;
}

export const opts = <T extends { id: string }>(xs: T[] | undefined, label: (x: T) => string) => (xs ?? []).map((x) => ({ value: x.id, label: label(x) }));
