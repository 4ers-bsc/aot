-- ============================================================================
-- admin_read_marks — generic "mark as read / acknowledged" store for the ops
-- dashboard. One row per (queue, item) an operator has marked read, so read
-- state is shared across operators and survives reloads. Keyed by the tab name
-- (subject_type) + the item's stable id (subject_id), so the same underlying
-- match can be read in one queue and unread in another.
--
-- Written only by the f10admin edge function (service role); RLS on with no
-- policies blocks all direct client access.
-- ============================================================================

begin;

create table if not exists public.admin_read_marks (
  subject_type text not null,
  subject_id   text not null,
  marked_by    uuid references auth.users(id) on delete set null,
  marked_at    timestamptz not null default now(),
  primary key (subject_type, subject_id)
);

alter table public.admin_read_marks enable row level security;

commit;
