# Generation and reference integrity acceptance contract

Status: launch-blocking database contract  
Scope: reference retrieval/snapshots, provider-call accounting, anti-copy
settlement, output recording, credits, and database grants

This document is deliberately kept beside the SQL tests. It defines the
observable invariants that migrations and transactional database tests must
prove. An Edge Function check, application convention, or comment is not
sufficient evidence for an invariant marked **database-enforced**.

## Terms

- `J`: one generation job owned by user `U`.
- `S`: the reference snapshot selected for `J`.
- `C0`: the initial provider call for `J` (`candidate_index = 0`).
- `C1`: the single system-funded reroll (`candidate_index = 1`).
- `A`: a generated-asset metadata row recorded for `J`.
- `similarity(C)`: the maximum output-to-reference similarity persisted for a
  completed provider call.
- `manifest(C)`: the canonical hash of the non-identity references actually
  sent in a provider call. Ordering and duplicate inputs must not permit two
  equivalent manifests to hash differently.

## Required invariants

### 1. Rights-safe retrieval is atomic and exact

Reference retrieval must create `S` with **exactly three distinct references**
or create nothing. Every selected reference must be rights-safe at the instant
the snapshot is made. Rights evidence must be data, not an untrusted request
boolean: at minimum the snapshot preserves source/reference identity, immutable
content hash, license or rights decision, the evidence/version used for that
decision, and retrieval/index version.

**Database-enforced acceptance:**

- A successful retrieval transaction commits exactly three snapshot members.
- Zero, one, two, or four members cannot be committed as a usable snapshot.
- Duplicate reference IDs or duplicate content hashes cannot satisfy the count.
- A revoked, expired, unverified, or otherwise non-safe reference is ineligible.
- If fewer than three eligible references exist, the transaction leaves no
  partial snapshot, provider call, credit debit, or generated asset.
- A snapshot and its members cannot be updated after sealing. Deletion is only
  permitted as part of the owning job/account retention path; it must never be
  usable as an in-place rewrite.
- A provider call references one sealed snapshot belonging to the same `J` and
  `U`. The caller cannot substitute raw reference IDs after retrieval.

The database should express the exact-three rule with a deferred constraint,
sealed-state transition, or a service-only sealing RPC that checks the member
count in the same transaction. A plain `CHECK` on a cached count is insufficient
unless all member mutation is inaccessible and the count is maintained by a
database trigger.

### 2. There are at most two provider calls

For each `J`, the only legal candidate indexes are `0` and `1`, and
`(job_id, candidate_index)` is unique. A retry of an idempotency key returns the
existing call; it never inserts another row or produces another charge.

**Database-enforced acceptance:**

- `C0` can be reserved once.
- `C1` can be reserved once and only through the reroll transition below.
- Candidate index `2`, a second `C0`, a second `C1`, and a third provider call
  under any alternate attempt/candidate field all fail atomically.
- Concurrent reservations for the same job produce the same single winner.

### 3. The reroll transition is narrow and uses different references

`C1` may be reserved only after `C0` has reached the terminal anti-copy outcome:

```text
C0.status = rejected
C0.rejection_reason = copy_similarity
similarity(C0) > 0.95
```

The comparison is intentionally strict. `0.950000...` is not a copy rejection;
the smallest representable value greater than `0.95` is. Similarity must use a
fixed-scale numeric type or an explicitly versioned normalization rule so that
binary floating-point rounding cannot change this boundary.

`manifest(C1)` must be non-null and unequal to `manifest(C0)`. If the selection
algorithm cannot produce a genuinely different eligible manifest, the job
terminates without calling the provider again. Changing only order, duplicated
IDs, signed-URL query parameters, or metadata timestamps is not different.

No other failure (provider timeout, moderation, invalid output, internal error,
or a similarity at or below `0.95`) authorizes the system-funded reroll.

### 4. Accepted provider-call evidence precedes output metadata

`record_scene_generation_output` (or its sole successor) must reject an output
unless its `provider_call_id` identifies a call that:

1. exists and is immutable/terminal;
2. belongs to the same `J`, `U`, and generation attempt as the output;
3. has `status = accepted`;
4. has a persisted output content hash equal to the hash being recorded; and
5. has not already been consumed by another generated asset.

`generated_assets.provider_call_id` must be non-null and protected by a foreign
key. A uniqueness constraint must prevent one accepted call from backing two
assets. Cross-owner or cross-job substitution must fail even when UUIDs are
known. A request field such as `accepted: true` is not evidence.

The accepted-call check and asset insert must occur in one transaction while
locking the provider-call/job settlement row. Recording the asset before
acceptance, accepting a call after an asset exists, or deleting the accepted
call while retaining `A` must be impossible.

This database invariant governs metadata. The service must separately prove
that rejected candidate bytes are never uploaded to object storage and that the
recorded object hash matches the accepted-call/output hash.

### 5. Funding and user-credit settlement are unambiguous

Funding is derived by the database, never accepted from the client:

| Path | `C0` funding | `C1` funding | Final user-credit consumption |
| --- | --- | --- | --- |
| `C0` accepted | user | absent | exactly one |
| `C0` copy-rejected, `C1` accepted | user | system reroll | exactly one |
| `C0` copy-rejected, `C1` rejected/fails | user reservation | system reroll | zero; reservation released |
| failure before any provider call | absent | absent | zero |

The user must never be debited for `C1`. The system-funded ledger entry must be
attributable to exactly one `C1`; it cannot be reused to hide additional calls.
Settlement is idempotent, and terminal replay cannot change a released credit
into a debit or add another debit. Credit ledger rows should reference `J` and
the funded provider call with uniqueness sufficient to enforce these rules.

### 6. Mutations are service-only

The following capabilities must not be executable by `PUBLIC`, `anon`, or
`authenticated`:

- reference ingestion/index mutation and rights-decision mutation;
- exact-three retrieval/snapshot creation and snapshot sealing;
- provider-call reservation, result/rejection recording, and reroll reservation;
- credit settlement attributed to provider calls;
- generated-output recording/finalization.

They must be reachable only by the service role (and database owner/migration
roles). Revoke default function execution from `PUBLIC` before granting the
service role. Base tables must have RLS enabled, with no client insert/update/
delete policy that bypasses the RPC boundary. Any owner-scoped client read must
be a separate, least-privilege path and must not expose reusable embeddings,
provider secrets, raw rights evidence, or other users' rows.

For every security-definer routine, pin a safe `search_path`, schema-qualify
objects, validate the authenticated owner supplied by the trusted service, and
do not trust caller-provided owner, funding, acceptance, rights, or similarity
decisions.

## Transactional acceptance matrix

The SQL integration suite must run each case in a transaction against a freshly
migrated local database and roll it back. Tests should assert SQLSTATE and final
rows, not only that an RPC returned an error string.

| Case | Operation | Required result |
| --- | --- | --- |
| R1 | Retrieve with exactly 3 eligible distinct refs | One sealed snapshot and 3 immutable members |
| R2 | Retrieve with only 2 eligible refs | Failure; no snapshot/call/credit rows |
| R3 | Include one revoked or expired ref | Failure or replacement with an eligible ref; unsafe ref absent |
| R4 | Duplicate an ID/content hash to reach 3 | Failure; duplicates do not count |
| R5 | Update/delete a sealed member directly | Failure |
| R6 | Revoke source rights after sealing | Existing snapshot remains auditable; new retrieval excludes source |
| P1 | Reserve `C0` twice, including concurrently | One row and one user reservation |
| P2 | Reserve candidate 2 | Failure |
| P3 | Reserve `C1` before `C0` is terminal | Failure |
| P4 | Reserve `C1` after a non-copy failure | Failure |
| P5 | Set `similarity(C0) = 0.95` and request `C1` | Failure; no reroll |
| P6 | Set `similarity(C0) > 0.95` by one storage unit | `C1` may be reserved once |
| P7 | Give `C1` an equivalent/canonically reordered manifest | Failure |
| P8 | Give eligible `C1` a different manifest | One system-funded call; no second user debit |
| A1 | Record output without `provider_call_id` | Failure |
| A2 | Record output for pending/rejected call | Failure |
| A3 | Use accepted call from another owner/job/attempt | Failure |
| A4 | Use an output hash different from accepted call | Failure |
| A5 | Reuse one accepted call for a second asset | Failure |
| A6 | Record one matching accepted output | One asset; finalization remains idempotent |
| C1 | `C0` succeeds | Exactly one final user debit |
| C2 | `C1` succeeds | Exactly one final user debit plus one system-funded call |
| C3 | Both candidates fail | User reservation released; no asset |
| G1 | Call every mutation RPC as `anon`/`authenticated` | Permission denied with no state change |
| G2 | Directly mutate each base table as a client role | Permission denied with no state change |
| G3 | Call mutation RPC as service role with valid owner/job | Only the requested owner/job changes |

## Minimum catalog assertions

Before behavioral fixtures run, the suite must fail if any of the following is
missing:

- exact-three enforcement tied to snapshot sealing;
- uniqueness and range enforcement for provider-call candidate index;
- a non-null owner/job-safe foreign-key path from generated asset to accepted
  provider call, plus one-call/one-asset uniqueness;
- immutable terminal provider-call fields (status, reason, similarity, hashes,
  funding, candidate index, owner/job/attempt);
- immutable sealed snapshot and member rows;
- RLS on all participating base tables;
- explicit `PUBLIC`, `anon`, and `authenticated` execute revocations on mutation
  routines;
- explicit service-role execute grants;
- a pinned `search_path` on every security-definer routine.

## Launch evidence threshold

This contract is satisfied only when all of the following are attached to the
release evidence:

1. migrated-schema catalog assertions pass;
2. every transactional case above passes, including concurrent `P1`;
3. an object-storage test proves both rejected candidates leave no object;
4. an idempotency replay test proves no third provider call or second charge;
5. the migration is tested both on an empty database and as a forward upgrade
   from the currently deployed generation-integrity schema.

Static review can confirm intent but cannot establish transactional behavior,
role grants in the migrated database, numeric boundary behavior, or object-
storage cleanup. Those remain launch blockers until the database and storage
fixtures run.
