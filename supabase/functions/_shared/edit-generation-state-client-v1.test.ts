import {
  beginEditProviderCallV1,
  buildEditRequestManifestV1,
  claimEditGenerationV1,
  EditGenerationStateError,
  editOutputStoragePathV1,
  recordEditProviderFailureDurablyV1,
  recordEditProviderResultDurablyV1,
  recoverEditProviderResultV1,
  reserveEditGenerationV1,
  settleEditGenerationDurablyV1,
} from "./edit-generation-state-client-v1.ts";
import type {
  EditProviderResultManifestV1,
  EditRpcInvoker,
  EditRpcResultLike,
} from "./edit-generation-state-client-v1.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = "values differ") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const PROFILE = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const LEASE = "33333333-3333-4333-8333-333333333333";
const CALL = "44444444-4444-4444-8444-444444444444";
const HASH = "a".repeat(64);

const manifest = buildEditRequestManifestV1({
  provider: "google-gemini",
  modelRef: "gemini-edit-test",
  promptVersion: "edit-prompt-v1",
  kind: "describe",
  photoId: "local-photo-1",
  inputSha256: "1".repeat(64),
  instructionSha256: "2".repeat(64),
  maskSha256: "3".repeat(64),
});

const resultManifest: EditProviderResultManifestV1 = {
  schema: "edit-provider-result-v1",
  providerRequestId: "provider-1",
  outputStorageBucket: "edits",
  outputStoragePath: editOutputStoragePathV1(PROFILE, JOB, "image/jpeg"),
  outputMimeType: "image/jpeg",
  outputByteSize: 1024,
  outputSha256: "4".repeat(64),
  width: 1024,
  height: 768,
  inputUnits: 10,
  outputUnits: 20,
  costMicros: 1234,
  billingState: "reported",
  providerMeta: { pricingStatus: "priced", modelVersion: "test" },
};

Deno.test("request manifest is exact, hash-only, and mask-consistent", () => {
  assertEquals(manifest, {
    schema: "edit-request-v1",
    provider: "google-gemini",
    modelRef: "gemini-edit-test",
    promptVersion: "edit-prompt-v1",
    kind: "describe",
    photoId: "local-photo-1",
    style: null,
    inputSha256: "1".repeat(64),
    instructionSha256: "2".repeat(64),
    hasMask: true,
    maskSha256: "3".repeat(64),
  });
  assertEquals(
    editOutputStoragePathV1(PROFILE, JOB, "image/webp"),
    `${PROFILE}/edit/${JOB}/output.webp`,
  );
  assert(!JSON.stringify(manifest).includes("instructionText"));
});

Deno.test("manifest builder rejects non-SHA evidence", () => {
  try {
    buildEditRequestManifestV1({
      provider: "google-gemini",
      modelRef: "model",
      promptVersion: "v1",
      kind: "describe",
      inputSha256: "not-a-hash",
      instructionSha256: "2".repeat(64),
    });
  } catch (error) {
    assert(error instanceof EditGenerationStateError);
    assertEquals(error.code, "invalid_request");
    return;
  }
  throw new Error("expected invalid manifest rejection");
});

Deno.test("reservation sends the lifetime idempotency manifest exactly", async () => {
  let observed: unknown;
  const rpc: EditRpcInvoker = (name, args) => {
    observed = { name, args };
    return Promise.resolve({
      data: [{
        job_id: JOB,
        job_status: "reserved",
        replayed: false,
        request_hash: HASH,
        quota_state: "held",
        plan_snapshot: "free",
        quota_period_start: "2026-08-01",
        output_storage_paths: [
          `${PROFILE}/edit/${JOB}/output.jpg`,
          `${PROFILE}/edit/${JOB}/output.png`,
          `${PROFILE}/edit/${JOB}/output.webp`,
        ],
      }],
      error: null,
    });
  };
  const row = await reserveEditGenerationV1(rpc, {
    profileId: PROFILE,
    idempotencyKey: "edit-request-0001",
    requestManifest: manifest,
  });
  assertEquals(observed, {
    name: "reserve_edit_generation",
    args: {
      p_profile_id: PROFILE,
      p_idempotency_key: "edit-request-0001",
      p_request_manifest: manifest,
    },
  });
  assertEquals(row.jobId, JOB);
  assertEquals(row.quotaState, "held");
});

Deno.test("claim forwards the caller-generated replay token", async () => {
  let observedArgs: unknown;
  const rpc: EditRpcInvoker = (_name, args) => {
    observedArgs = args;
    return Promise.resolve({
      data: [{
        claimed: true,
        replayed: false,
        job_status: "processing",
        attempt_number: 1,
        lease_token: LEASE,
        lease_expires_at: "2026-08-29T12:10:00Z",
      }],
      error: null,
    });
  };
  const claim = await claimEditGenerationV1(rpc, {
    jobId: JOB,
    profileId: PROFILE,
    leaseToken: LEASE,
  });
  assertEquals(observedArgs, {
    p_job_id: JOB,
    p_profile_id: PROFILE,
    p_lease_token: LEASE,
  });
  assertEquals(claim.attemptNumber, 1);
});

Deno.test("provider preparation errors never auto-retry or authorize HTTP", async () => {
  let calls = 0;
  const rpc: EditRpcInvoker = () => {
    calls += 1;
    return Promise.resolve({
      data: null,
      error: { code: "08006", message: "connection lost" },
    });
  };
  try {
    await beginEditProviderCallV1(rpc, {
      jobId: JOB,
      profileId: PROFILE,
      attemptNumber: 1,
      leaseToken: LEASE,
      callId: CALL,
      requestHash: HASH,
    });
  } catch (error) {
    assert(error instanceof EditGenerationStateError);
    assertEquals(error.code, "provider_preparation_unknown");
    assertEquals(calls, 1);
    assert(error.message.includes("do not invoke the provider"));
    return;
  }
  throw new Error("expected provider preparation failure");
});

Deno.test("provider preparation replay returns invokeAllowed false", async () => {
  const rpc: EditRpcInvoker = () => Promise.resolve({
    data: [{
      invoke_allowed: false,
      call_id: CALL,
      call_status: "prepared",
      job_status: "provider_prepared",
    }],
    error: null,
  });
  const prepared = await beginEditProviderCallV1(rpc, {
    jobId: JOB,
    profileId: PROFILE,
    attemptNumber: 1,
    leaseToken: LEASE,
    callId: CALL,
    requestHash: HASH,
  });
  assertEquals(prepared.invokeAllowed, false);
});

Deno.test("result capture retries only the identical DB payload", async () => {
  const observed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc: EditRpcInvoker = (name, args): Promise<EditRpcResultLike> => {
    observed.push({ name, args });
    if (observed.length === 1) {
      return Promise.resolve({ data: null, error: { message: "transient" } });
    }
    return Promise.resolve({
      data: [{
        captured: true,
        replayed: true,
        job_status: "result_captured",
        result_hash: HASH,
      }],
      error: null,
    });
  };
  const captured = await recordEditProviderResultDurablyV1(rpc, {
    jobId: JOB,
    profileId: PROFILE,
    attemptNumber: 1,
    leaseToken: LEASE,
    callId: CALL,
    resultManifest,
  });
  assertEquals(observed.length, 2);
  assertEquals(observed[0], observed[1]);
  assertEquals(captured.replayed, true);
});

Deno.test("terminal provider failure retries identical evidence, never HTTP", async () => {
  const observed: Record<string, unknown>[] = [];
  const rpc: EditRpcInvoker = (_name, args) => {
    observed.push(args);
    if (observed.length === 1) {
      return Promise.resolve({ data: null, error: { message: "transient" } });
    }
    return Promise.resolve({
      data: [{
        recorded: true,
        replayed: true,
        job_status: "indeterminate",
        call_status: "indeterminate",
        quota_state: "held",
      }],
      error: null,
    });
  };
  const failed = await recordEditProviderFailureDurablyV1(rpc, {
    jobId: JOB,
    profileId: PROFILE,
    attemptNumber: 1,
    leaseToken: LEASE,
    callId: CALL,
    outcome: "indeterminate",
    errorCode: "provider_outcome_unknown",
    errorDetail: "connection closed after request",
  });
  assertEquals(observed[0], observed[1]);
  assertEquals(failed.quotaState, "held");
});

Deno.test("deterministic recovery forwards unknown-cost evidence", async () => {
  const recoveredManifest: EditProviderResultManifestV1 = {
    ...resultManifest,
    providerRequestId: null,
    costMicros: null,
    billingState: "unknown",
    providerMeta: {
      pricingStatus: "unpriced",
      recoveredFromDeterministicStorage: true,
    },
  };
  let observedArgs: Record<string, unknown> = {};
  const rpc: EditRpcInvoker = (_name, args) => {
    observedArgs = args;
    return Promise.resolve({
      data: [{
        captured: true,
        replayed: false,
        job_status: "result_captured",
        result_hash: HASH,
      }],
      error: null,
    });
  };
  await recoverEditProviderResultV1(rpc, {
    jobId: JOB,
    profileId: PROFILE,
    callId: CALL,
    resultManifest: recoveredManifest,
  });
  assertEquals(observedArgs.p_result_manifest, recoveredManifest);
});

Deno.test("settlement retries the same path/hash and returns one taste event", async () => {
  const observed: Record<string, unknown>[] = [];
  const rpc: EditRpcInvoker = (_name, args) => {
    observed.push(args);
    if (observed.length === 1) {
      return Promise.resolve({ data: null, error: { message: "timeout" } });
    }
    return Promise.resolve({
      data: [{
        delivered: true,
        replayed: true,
        job_status: "delivered",
        quota_state: "charged",
        taste_event_id: "55555555-5555-4555-8555-555555555555",
      }],
      error: null,
    });
  };
  const settled = await settleEditGenerationDurablyV1(rpc, {
    jobId: JOB,
    profileId: PROFILE,
    outputStoragePath: resultManifest.outputStoragePath,
    outputSha256: resultManifest.outputSha256,
  });
  assertEquals(observed[0], observed[1]);
  assertEquals(settled.quotaState, "charged");
  assertEquals(settled.replayed, true);
});
