import {
  canonicalReferenceIndexJsonV1,
  failClaimedReferenceIndexRunBeforeProviderV1,
  ReferenceIndexOrchestratorError,
  type ReferenceIndexProviderStageInputV1,
  runReferenceIndexProviderStageV1,
} from "./reference-index-orchestrator-v1.ts";
import type {
  RpcInvoker,
  RpcResultLike,
} from "./reference-index-state-client-v1.ts";
import { reapStaleReferenceIndexWork } from "./reference-index-state-client-v1.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "values differ",
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";
const CALL_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_HASH = "a".repeat(64);

type CallRow = {
  id: string;
  stage: "vision" | "text_embedding" | "visual_embedding";
  callOrdinal: number;
  status: string;
  modelRef: string;
  requestHash: string;
  responsePayload?: Record<string, unknown>;
  responseHash?: string;
};

function harness(options: {
  calls?: CallRow[];
  resultFailures?: number;
  reservationRace?: boolean;
  runStatus?: string;
  runAttempt?: number;
  runLease?: string | null;
  failRunFailures?: number;
} = {}) {
  const calls = [...(options.calls ?? [])];
  let resultFailures = options.resultFailures ?? 0;
  let failRunFailures = options.failRunFailures ?? 0;
  let runStatus = options.runStatus ?? "processing";
  const runAttempt = options.runAttempt ?? 1;
  let runLease = options.runLease === undefined
    ? LEASE_TOKEN
    : options.runLease;
  let providerCalls = 0;
  let beginCalls = 0;
  let resultCalls = 0;
  let failureCalls = 0;
  let failRunCalls = 0;
  const events: string[] = [];

  const rpc: RpcInvoker = async (name, args): Promise<RpcResultLike> => {
    await Promise.resolve();
    events.push(name);
    if (name === "get_reference_index_run_state") {
      return {
        data: {
          status: runStatus,
          attemptNumber: runAttempt,
          leaseToken: runLease,
          calls,
        },
        error: null,
      };
    }
    if (name === "begin_reference_index_provider_call") {
      beginCalls += 1;
      let call = calls.find((row) =>
        row.stage === args.p_stage && row.callOrdinal === args.p_call_ordinal
      );
      if (!call) {
        call = {
          id: String(args.p_call_id),
          stage: args.p_stage as CallRow["stage"],
          callOrdinal: Number(args.p_call_ordinal),
          status: "prepared",
          modelRef: String(args.p_model_ref),
          requestHash: String(args.p_request_hash),
        };
        calls.push(call);
      }
      return {
        data: [{
          invoke_allowed: options.reservationRace !== true,
          call_id: call.id,
          call_status: call.status,
        }],
        error: null,
      };
    }
    if (name === "record_reference_index_provider_result") {
      resultCalls += 1;
      if (resultFailures > 0) {
        resultFailures -= 1;
        return { data: null, error: { message: "synthetic commit failure" } };
      }
      const call = calls.find((row) => row.id === args.p_call_id)!;
      call.status = "succeeded";
      call.responsePayload = args.p_response_payload as Record<string, unknown>;
      call.responseHash = "b".repeat(64);
      return {
        data: [{
          staged: true,
          replayed: false,
          response_hash: call.responseHash,
        }],
        error: null,
      };
    }
    if (name === "record_reference_index_provider_failure") {
      failureCalls += 1;
      const call = calls.find((row) => row.id === args.p_call_id)!;
      call.status = String(args.p_outcome);
      return { data: call.status, error: null };
    }
    if (name === "fail_reference_index_run") {
      failRunCalls += 1;
      if (failRunFailures > 0) {
        failRunFailures -= 1;
        return {
          data: null,
          error: { message: "synthetic fail commit error" },
        };
      }
      const replayed = runStatus === "failed";
      runStatus = "failed";
      runLease = null;
      return {
        data: [{ failed: true, replayed, run_status: runStatus }],
        error: null,
      };
    }
    throw new Error(`unexpected RPC ${name}`);
  };

  const input = (
    overrides: Partial<ReferenceIndexProviderStageInputV1<{ answer: string }>> =
      {},
  ): ReferenceIndexProviderStageInputV1<{ answer: string }> => ({
    rpc,
    runId: RUN_ID,
    requestedBy: PROFILE_ID,
    attemptNumber: 1,
    leaseToken: LEASE_TOKEN,
    stage: "vision" as const,
    callOrdinal: 0,
    modelRef: "gemini-test",
    requestHash: REQUEST_HASH,
    createCallId: () => CALL_ID,
    invokeOnce: async () => {
      await Promise.resolve();
      providerCalls += 1;
      events.push("provider-http");
      return {
        value: { answer: "fresh" },
        ledger: {
          responsePayload: { answer: "fresh" },
          providerRequestId: "provider-1",
          inputUnits: 10,
          outputUnits: 4,
          costMicros: 3,
          providerMeta: { pricingVersion: "test-v1" },
        },
      };
    },
    decodeResponse: (payload: unknown) => ({
      answer: String((payload as Record<string, unknown>).answer),
    }),
    classifyFailure: (error: unknown) => ({
      outcome: "rejected" as const,
      errorCode: "provider_rejected",
      errorDetail: String(error),
    }),
    ...overrides,
  });

  return {
    calls,
    events,
    input,
    providerCalls: () => providerCalls,
    beginCalls: () => beginCalls,
    resultCalls: () => resultCalls,
    failureCalls: () => failureCalls,
    failRunCalls: () => failRunCalls,
  };
}

Deno.test("canonical request JSON is stable across object key order", () => {
  const left = canonicalReferenceIndexJsonV1({ b: 2, a: { y: true, x: "v" } });
  const right = canonicalReferenceIndexJsonV1({ a: { x: "v", y: true }, b: 2 });
  assertEquals(left, right);
  assertEquals(left, '{"a":{"x":"v","y":true},"b":2}');
});

Deno.test("fresh durable stage reserves before exactly one provider invocation", async () => {
  const state = harness();
  const result = await runReferenceIndexProviderStageV1(state.input());
  assertEquals(result.value, { answer: "fresh" });
  assertEquals(result.replayed, false);
  assertEquals(state.providerCalls(), 1);
  assertEquals(state.beginCalls(), 1);
  assertEquals(state.resultCalls(), 1);
  assert(
    state.events.indexOf("begin_reference_index_provider_call") <
      state.events.indexOf("provider-http"),
    "provider ran before durable reservation",
  );
});

Deno.test("succeeded stage resumes from normalized payload without provider HTTP", async () => {
  const state = harness({
    calls: [{
      id: CALL_ID,
      stage: "vision",
      callOrdinal: 0,
      status: "succeeded",
      modelRef: "gemini-test",
      requestHash: REQUEST_HASH,
      responsePayload: { answer: "recovered" },
      responseHash: "c".repeat(64),
    }],
  });
  const result = await runReferenceIndexProviderStageV1(state.input());
  assertEquals(result.value, { answer: "recovered" });
  assertEquals(result.replayed, true);
  assertEquals(state.providerCalls(), 0);
  assertEquals(state.beginCalls(), 0);
});

Deno.test("prepared stage forbids provider replay", async () => {
  const state = harness({
    calls: [{
      id: CALL_ID,
      stage: "vision",
      callOrdinal: 0,
      status: "prepared",
      modelRef: "gemini-test",
      requestHash: REQUEST_HASH,
    }],
  });
  let caught: unknown;
  try {
    await runReferenceIndexProviderStageV1(state.input());
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ReferenceIndexOrchestratorError);
  assertEquals(caught.code, "provider_call_recovery_required");
  assertEquals(state.providerCalls(), 0);
});

Deno.test("database result staging retries the same payload, never provider HTTP", async () => {
  const state = harness({ resultFailures: 2 });
  const result = await runReferenceIndexProviderStageV1(state.input());
  assertEquals(result.value, { answer: "fresh" });
  assertEquals(state.providerCalls(), 1);
  assertEquals(state.resultCalls(), 3);
});

Deno.test("unknown result commit fails closed after one provider invocation", async () => {
  const state = harness({ resultFailures: 3 });
  let caught: unknown;
  try {
    await runReferenceIndexProviderStageV1(state.input());
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ReferenceIndexOrchestratorError);
  assertEquals(caught.code, "provider_result_commit_unknown");
  assertEquals(caught.providerMayHaveRun, true);
  assertEquals(state.providerCalls(), 1);
  assertEquals(state.resultCalls(), 3);
});

Deno.test("reservation race is re-read and never invokes provider", async () => {
  const state = harness({ reservationRace: true });
  let caught: unknown;
  try {
    await runReferenceIndexProviderStageV1(state.input());
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ReferenceIndexOrchestratorError);
  assertEquals(caught.code, "provider_call_recovery_required");
  assertEquals(state.providerCalls(), 0);
});

Deno.test("stored provider request drift is rejected before HTTP", async () => {
  const state = harness({
    calls: [{
      id: CALL_ID,
      stage: "vision",
      callOrdinal: 0,
      status: "succeeded",
      modelRef: "different-model",
      requestHash: REQUEST_HASH,
      responsePayload: { answer: "wrong" },
    }],
  });
  let caught: unknown;
  try {
    await runReferenceIndexProviderStageV1(state.input());
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ReferenceIndexOrchestratorError);
  assertEquals(caught.code, "provider_call_contract_mismatch");
  assertEquals(state.providerCalls(), 0);
});

Deno.test("provider error is recorded once and the provider is not retried", async () => {
  const state = harness();
  const providerError = new Error("provider rejected request");
  let caught: unknown;
  try {
    await runReferenceIndexProviderStageV1(state.input({
      invokeOnce: async () => {
        await Promise.resolve();
        state.events.push("provider-http");
        throw providerError;
      },
    }));
  } catch (error) {
    caught = error;
  }
  assert(caught === providerError);
  assertEquals(state.failureCalls(), 1);
  assertEquals(state.resultCalls(), 0);
  assertEquals(
    state.events.filter((event) => event === "provider-http").length,
    1,
  );
});

Deno.test("invalid provider ledger fails durably without another HTTP call", async () => {
  const state = harness();
  let caught: unknown;
  try {
    await runReferenceIndexProviderStageV1(state.input({
      invokeOnce: async () => {
        await Promise.resolve();
        state.events.push("provider-http");
        return {
          value: { answer: "invalid" },
          ledger: {
            responsePayload: { answer: "invalid" },
            inputUnits: 0,
            outputUnits: 0,
            costMicros: -1,
          },
        };
      },
    }));
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ReferenceIndexOrchestratorError);
  assertEquals(caught.code, "invalid_input");
  assertEquals(state.failureCalls(), 1);
  assertEquals(
    state.events.filter((event) => event === "provider-http").length,
    1,
  );
});

Deno.test("claimed local failure terminalizes before any provider call", async () => {
  const state = harness();
  const result = await failClaimedReferenceIndexRunBeforeProviderV1({
    rpc: state.input().rpc,
    runId: RUN_ID,
    requestedBy: PROFILE_ID,
    attemptNumber: 1,
    leaseToken: LEASE_TOKEN,
    errorCode: "reference_rights_revoked",
    errorDetail: "rights changed before provider reservation",
  });
  assertEquals(result, { disposition: "failed", status: "failed" });
  assertEquals(state.failRunCalls(), 1);
  assertEquals(state.beginCalls(), 0);
  assertEquals(state.providerCalls(), 0);
});

Deno.test("pre-provider failure retries only its identical database transition", async () => {
  const state = harness({ failRunFailures: 2 });
  const result = await failClaimedReferenceIndexRunBeforeProviderV1({
    rpc: state.input().rpc,
    runId: RUN_ID,
    requestedBy: PROFILE_ID,
    attemptNumber: 1,
    leaseToken: LEASE_TOKEN,
    errorCode: "local_precondition_failed",
    errorDetail: "same immutable failure payload",
  });
  assertEquals(result.disposition, "failed");
  assertEquals(state.failRunCalls(), 3);
  assertEquals(state.providerCalls(), 0);
});

Deno.test("terminal pre-provider failure replay bypasses the cleared lease", async () => {
  const state = harness({ runStatus: "failed", runLease: null });
  const result = await failClaimedReferenceIndexRunBeforeProviderV1({
    rpc: state.input().rpc,
    runId: RUN_ID,
    requestedBy: PROFILE_ID,
    attemptNumber: 1,
    leaseToken: LEASE_TOKEN,
    errorCode: "local_precondition_failed",
    errorDetail: "same immutable failure payload",
  });
  assertEquals(result, { disposition: "replayed", status: "failed" });
  assertEquals(state.failRunCalls(), 1);
});

Deno.test("existing provider call forbids pre-provider failure transition", async () => {
  const state = harness({
    calls: [{
      id: CALL_ID,
      stage: "vision",
      callOrdinal: 0,
      status: "prepared",
      modelRef: "gemini-test",
      requestHash: REQUEST_HASH,
    }],
  });
  const result = await failClaimedReferenceIndexRunBeforeProviderV1({
    rpc: state.input().rpc,
    runId: RUN_ID,
    requestedBy: PROFILE_ID,
    attemptNumber: 1,
    leaseToken: LEASE_TOKEN,
    errorCode: "local_precondition_failed",
    errorDetail: "must not overwrite a prepared call",
  });
  assertEquals(result, {
    disposition: "not_applicable",
    status: "processing",
    reason: "provider_call_exists",
  });
  assertEquals(state.failRunCalls(), 0);
});

Deno.test("changed attempt lease forbids stale pre-provider failure", async () => {
  const state = harness({
    runLease: "55555555-5555-4555-8555-555555555555",
  });
  const result = await failClaimedReferenceIndexRunBeforeProviderV1({
    rpc: state.input().rpc,
    runId: RUN_ID,
    requestedBy: PROFILE_ID,
    attemptNumber: 1,
    leaseToken: LEASE_TOKEN,
    errorCode: "local_precondition_failed",
    errorDetail: "stale worker",
  });
  assertEquals(result, {
    disposition: "not_applicable",
    status: "processing",
    reason: "attempt_or_lease_changed",
  });
  assertEquals(state.failRunCalls(), 0);
});

Deno.test("bounded opportunistic reaper maps the service RPC contract", async () => {
  let observed: { name: string; args: Record<string, unknown> } | null = null;
  const rpc: RpcInvoker = async (name, args) => {
    await Promise.resolve();
    observed = { name, args };
    return {
      data: [{
        work_kind: "run",
        work_id: RUN_ID,
        previous_status: "processing",
        resulting_status: "reserved",
      }],
      error: null,
    };
  };
  const rows = await reapStaleReferenceIndexWork(rpc, {
    limit: 10,
    reservationGraceSeconds: 900,
  });
  assertEquals(observed, {
    name: "reap_stale_reference_index_work",
    args: { p_limit: 10, p_reservation_grace_seconds: 900 },
  });
  assertEquals(rows, [{
    workKind: "run",
    workId: RUN_ID,
    previousStatus: "processing",
    resultingStatus: "reserved",
  }]);
});
