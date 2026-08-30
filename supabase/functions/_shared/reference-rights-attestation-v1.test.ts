import {
  attestInspirationAssetRightsV1,
  parseReferenceRightsAttestationsV1,
  REFERENCE_RIGHTS_POLICY_VERSION,
  ReferenceRightsAttestationError,
} from "./reference-rights-attestation-v1.ts";
import type {
  RpcInvoker,
  RpcResultLike,
} from "./reference-index-state-client-v1.ts";

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
) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function assertInvalid(run: () => unknown, expectedMessage: string): void {
  try {
    run();
  } catch (error) {
    assert(error instanceof ReferenceRightsAttestationError);
    assertEquals(error.code, "invalid_request");
    assertEquals(error.message, expectedMessage);
    return;
  }
  throw new Error("expected validation failure");
}

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const OWNED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LICENSED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function attestation(
  assetId: string,
  rightsBasis: "owned" | "licensed",
) {
  return {
    assetId,
    rightsBasis,
    conditioningAuthorized: true as const,
    policyVersion: REFERENCE_RIGHTS_POLICY_VERSION,
  };
}

Deno.test("rights attestation omission is a no-op", () => {
  assertEquals(
    parseReferenceRightsAttestationsV1(undefined, [OWNED_ID], false),
    [],
  );
});

Deno.test("owned and licensed attestations are accepted and canonicalized", () => {
  assertEquals(
    parseReferenceRightsAttestationsV1(
      [
        attestation(LICENSED_ID.toUpperCase(), "licensed"),
        attestation(OWNED_ID, "owned"),
      ],
      [LICENSED_ID, OWNED_ID.toUpperCase()],
      false,
    ),
    [attestation(OWNED_ID, "owned"), attestation(LICENSED_ID, "licensed")],
  );
});

Deno.test("attestations must be unique requested IDs", () => {
  assertInvalid(
    () =>
      parseReferenceRightsAttestationsV1(
        [attestation(LICENSED_ID, "owned")],
        [OWNED_ID],
        false,
      ),
    "rights_attestation_item_invalid",
  );
  assertInvalid(
    () =>
      parseReferenceRightsAttestationsV1(
        [attestation(OWNED_ID, "owned"), attestation(OWNED_ID, "owned")],
        [OWNED_ID],
        false,
      ),
    "rights_attestation_item_invalid",
  );
});

Deno.test("rights assertion semantics and exact shape are mandatory", () => {
  assertInvalid(
    () =>
      parseReferenceRightsAttestationsV1(
        [{
          ...attestation(OWNED_ID, "owned"),
          conditioningAuthorized: false,
        }],
        [OWNED_ID],
        false,
      ),
    "rights_attestation_item_invalid",
  );
  assertInvalid(
    () =>
      parseReferenceRightsAttestationsV1(
        [{
          ...attestation(OWNED_ID, "owned"),
          extra: "not-signed",
        }],
        [OWNED_ID],
        false,
      ),
    "rights_attestation_item_invalid",
  );
});

Deno.test("backfill cannot carry owner rights attestations", () => {
  assertInvalid(
    () =>
      parseReferenceRightsAttestationsV1(
        [attestation(OWNED_ID, "owned")],
        [OWNED_ID],
        true,
      ),
    "rights_attestations_not_allowed_for_backfill",
  );
});

Deno.test("attestation RPC receives canonical service-only payload", async () => {
  let observedName = "";
  let observedArgs: Record<string, unknown> = {};
  const rpc: RpcInvoker = (name, args): Promise<RpcResultLike> => {
    observedName = name;
    observedArgs = args;
    return Promise.resolve({
      data: [{
        attestation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        asset_id: OWNED_ID,
        rights_basis: "owned",
        conditioning_authorized: true,
        policy_version: REFERENCE_RIGHTS_POLICY_VERSION,
        replayed: false,
        attested_at: "2026-08-29T12:00:00.000Z",
      }],
      error: null,
    });
  };
  const rows = await attestInspirationAssetRightsV1(rpc, {
    profileId: PROFILE_ID,
    idempotencyKey: "batch-0001:rights",
    attestations: [attestation(OWNED_ID, "owned")],
  });
  assertEquals(observedName, "attest_inspiration_asset_rights");
  assertEquals(observedArgs, {
    p_profile_id: PROFILE_ID,
    p_idempotency_key: "batch-0001:rights",
    p_attestations: [attestation(OWNED_ID, "owned")],
  });
  assertEquals(rows, [{
    ...attestation(OWNED_ID, "owned"),
    attestationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    replayed: false,
    attestedAt: "2026-08-29T12:00:00.000Z",
  }]);
});

Deno.test("attestation RPC rejects mismatched evidence", async () => {
  const rpc: RpcInvoker = (): Promise<RpcResultLike> =>
    Promise.resolve({
      data: [{
        attestation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        asset_id: OWNED_ID,
        rights_basis: "licensed",
        conditioning_authorized: true,
        policy_version: REFERENCE_RIGHTS_POLICY_VERSION,
        replayed: false,
        attested_at: "2026-08-29T12:00:00.000Z",
      }],
      error: null,
    });
  try {
    await attestInspirationAssetRightsV1(rpc, {
      profileId: PROFILE_ID,
      idempotencyKey: "batch-0001:rights",
      attestations: [attestation(OWNED_ID, "owned")],
    });
  } catch (error) {
    assert(error instanceof ReferenceRightsAttestationError);
    assertEquals(error.code, "invalid_rpc_response");
    return;
  }
  throw new Error("expected RPC evidence rejection");
});

Deno.test("attestation RPC preserves database error evidence", async () => {
  const rpc: RpcInvoker = (): Promise<RpcResultLike> =>
    Promise.resolve({
      data: null,
      error: { code: "42501", message: "forbidden" },
    });
  try {
    await attestInspirationAssetRightsV1(rpc, {
      profileId: PROFILE_ID,
      idempotencyKey: "batch-0001:rights",
      attestations: [attestation(OWNED_ID, "owned")],
    });
  } catch (error) {
    assert(error instanceof ReferenceRightsAttestationError);
    assertEquals(error.code, "database_error");
    assertEquals(error.rpcCause?.code, "42501");
    return;
  }
  throw new Error("expected database error");
});
