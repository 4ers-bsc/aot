-- ============================================================================
-- Admin review notes — free-text notes attached to a match / user / payout so
-- the operator can record how a dispute, ban or stuck payout was resolved.
--
-- Written and read ONLY by the f10admin edge function (service role). RLS is
-- enabled with no policies, so no browser client can touch it directly (same
-- lock-down as consumed_deposits / integrity_signals). The service role bypasses
-- RLS, so the edge function still has full access.
-- ============================================================================

create table if not exists public.review_notes (
  id           bigint generated always as identity primary key,
  -- What the note is about. subject_id holds the match UUID / user UUID /
  -- deposit signature (kept as text so one column serves every subject kind).
  subject_type text not null
    check (subject_type in ('match', 'user', 'payout', 'deposit', 'waiting', 'general')),
  subject_id   text,
  note         text not null check (char_length(note) between 1 and 2000),
  -- Machine tag for the action that produced this note (e.g. 'resolve_dispute',
  -- 'ban', 'unban', 'release_payout'); plain 'note' for a manual note.
  action       text,
  -- The admin (auth user) who wrote it. Kept for the audit trail; nulled if the
  -- account is ever deleted.
  author_id    uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_review_notes_subject
  on public.review_notes (subject_type, subject_id, created_at desc);
create index if not exists idx_review_notes_created
  on public.review_notes (created_at desc);

-- Service-role only: RLS on with no policies blocks every direct client read/write.
alter table public.review_notes enable row level security;
