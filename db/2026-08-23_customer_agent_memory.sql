-- Episodic agent memory per customer (what happened across ALL conversations).
-- Complements the existing cumulative personality profile columns.
-- Safe to re-run: additive only.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS memory_events        jsonb,
  ADD COLUMN IF NOT EXISTS memory_updated_at    timestamptz,
  ADD COLUMN IF NOT EXISTS memory_message_count int;

COMMENT ON COLUMN public.customers.memory_events IS
  'Cumulative episodic memory: { headline, timeline: [{kind,text,at,status}] }';
