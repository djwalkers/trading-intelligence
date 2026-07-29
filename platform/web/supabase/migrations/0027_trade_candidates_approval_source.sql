-- AUTO_DEMO approval-persistence defect fix.
--
-- Root cause: the AUTO_DEMO auto-approval path (trade-candidate-service.ts's own
-- autoApproveTradeCandidate) persisted a synthetic sentinel string ("system:auto-demo") into
-- trade_candidates.approved_by_user_id, a `uuid references auth.users (id)` column — Postgres
-- correctly rejected it ("invalid input syntax for type uuid"), the transition never committed, and
-- the candidate was left PENDING with the failure surfacing as an uncaught exception rather than a
-- clear, auditable outcome.
--
-- Fix: approved_by_user_id remains uuid, remains nullable (unchanged — it already was), and NEVER
-- receives anything other than a genuine auth.users id or null. A new, separate `approval_source`
-- column records WHO/WHAT kind of actor approved a candidate — 'HUMAN' (a real approved_by_user_id
-- is present) or 'AUTO_DEMO' (approved_by_user_id is null; the runtime's own audit trail carries the
-- full "system:auto-demo" provenance string in its event details, which is a jsonb/text field, never
-- a uuid one). This is the smallest change that preserves UUID column integrity while making system
-- approvals distinguishable from "not yet approved" and from a human approval — no new table, no
-- system-principal row, no relaxation of the uuid type itself.
--
-- The pre-existing trade_candidates_approved_fields_together constraint required approved_at and
-- approved_by_user_id to be null/non-null together — which is exactly why the old code had to invent
-- a fake uuid string in the first place (a null approved_by_user_id alongside a non-null approved_at
-- was previously impossible). It is replaced below by a three-way provenance constraint: not yet
-- approved (all three null), human-approved (approved_at + a real approved_by_user_id, no source
-- tag), or system-approved (approved_at + approval_source = 'AUTO_DEMO', approved_by_user_id null).

alter table trade_candidates
  add column if not exists approval_source text;

alter table trade_candidates
  add constraint trade_candidates_approval_source_valid
    check (approval_source is null or approval_source in ('AUTO_DEMO'));

alter table trade_candidates
  drop constraint if exists trade_candidates_approved_fields_together;

alter table trade_candidates
  add constraint trade_candidates_approval_provenance
    check (
      (approved_at is null and approved_by_user_id is null and approval_source is null)
      or (approved_at is not null and approved_by_user_id is not null and approval_source is null)
      or (approved_at is not null and approved_by_user_id is null and approval_source = 'AUTO_DEMO')
    );

comment on column trade_candidates.approval_source is
  'Null for a not-yet-approved candidate or a HUMAN approval (approved_by_user_id is the provenance in that case). ''AUTO_DEMO'' for a system auto-approval, where approved_by_user_id is deliberately null rather than a fabricated uuid — see trade-candidate-service.ts''s own autoApproveTradeCandidate.';
