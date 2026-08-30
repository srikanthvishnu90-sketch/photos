# Reference-index recovery path

`index-references` performs one opportunistic recovery sweep for every valid,
authenticated indexing request. It calls the service-only
`reap_stale_reference_index_work` RPC with `limit = 10` and a 900-second
reserved-run grace period after request authorization and before idempotent run
lookup.

The sweep is deliberately best-effort. A database error is logged and normal
request recovery continues; the next authorized request will try again. The RPC
uses `FOR UPDATE SKIP LOCKED`, so concurrent invocations divide work without
waiting on the same rows.

The reaper applies these transitions:

- Expired, unbound provisional asset claim: `indexing -> failed`.
- Expired processing lease with no prepared provider call: run requeues to
  `reserved` and keeps its asset bindings.
- Expired processing lease with a prepared provider call: call and run become
  `indeterminate`; provider HTTP is never replayed.
- Reserved run older than the grace period: run and bound assets become
  `failed`.

No `pg_cron`, Supabase scheduled function, or remote schedule is registered.
If traffic-independent recovery is later required, a trusted service-role
worker may call the same RPC; it must retain the migration's bounded arguments
and must not scan Storage or retry provider HTTP.

For local failures after a lease is claimed but before any provider-call row
exists, the handler uses `fail_reference_index_run`. The shared orchestrator
first reads durable state, verifies the attempt and empty call ledger, then the
RPC repeats the no-call assertion while holding the run lock. Identical database
failure writes may be retried; provider HTTP is never involved.
