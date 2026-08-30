const handler = await Deno.readTextFile(
  new URL("../index-references/index.ts", import.meta.url),
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertOrdered(earlier: string, later: string, message: string) {
  const earlierAt = handler.indexOf(earlier);
  const laterAt = handler.indexOf(later);
  assert(earlierAt >= 0, `missing earlier anchor: ${earlier}`);
  assert(laterAt >= 0, `missing later anchor: ${later}`);
  assert(earlierAt < laterAt, message);
}

Deno.test("authorized requests invoke the bounded reaper before run lookup", () => {
  assert(
    handler.includes("reapStaleReferenceIndexWork"),
    "reaper import missing",
  );
  assert(handler.includes("limit: 10"), "bounded reaper limit missing");
  assert(
    handler.includes("reservationGraceSeconds: 900"),
    "reservation grace missing",
  );
  assertOrdered(
    "if (backfill && !isAdmin)",
    "await reapStaleReferenceIndexWork",
    "reaper must run only after request authorization",
  );
  assertOrdered(
    "await reapStaleReferenceIndexWork",
    "existingRun = await findExistingRun",
    "reaper must run before idempotent run lookup",
  );
});

Deno.test("claimed catch path fails only through durable pre-provider guard", () => {
  assert(
    handler.includes("failClaimedReferenceIndexRunBeforeProviderV1"),
    "pre-provider failure helper import missing",
  );
  assertOrdered(
    "const detail = cleanText(",
    "await failClaimedReferenceIndexRunBeforeProviderV1",
    "failure payload must be normalized before the durable transition",
  );
  assertOrdered(
    "await failClaimedReferenceIndexRunBeforeProviderV1",
    "reference pre-provider failure commit unknown",
    "read-back fallback must follow the idempotent fail RPC",
  );
  assert(
    handler.includes('["failed", "indeterminate"].includes(durableStatus)'),
    "terminal read-back handling missing",
  );
});

Deno.test("handler registers no local or remote schedule", () => {
  assert(
    !/Deno\.cron|cron\.schedule|pg_cron/i.test(handler),
    "handler must not register a scheduler",
  );
  assert(
    handler.includes("No remote cron or schedule is registered"),
    "opportunistic invocation contract is undocumented",
  );
});
