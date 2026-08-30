import type {
  RpcErrorLike,
  RpcInvoker,
} from "./reference-index-state-client-v1.ts";

export const REFERENCE_RIGHTS_POLICY_VERSION =
  "conditioning-rights-v1" as const;
export type ReferenceRightsBasis = "owned" | "licensed";

export interface ReferenceRightsAttestationInputV1 {
  readonly assetId: string;
  readonly rightsBasis: ReferenceRightsBasis;
  readonly conditioningAuthorized: true;
  readonly policyVersion: typeof REFERENCE_RIGHTS_POLICY_VERSION;
}

export interface RecordedReferenceRightsAttestationV1
  extends ReferenceRightsAttestationInputV1 {
  readonly attestationId: string;
  readonly replayed: boolean;
  readonly attestedAt: string;
}

export class ReferenceRightsAttestationError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "database_error"
      | "invalid_rpc_response",
    message: string,
    readonly rpcCause?: RpcErrorLike,
  ) {
    super(message);
    this.name = "ReferenceRightsAttestationError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(message: string): never {
  throw new ReferenceRightsAttestationError("invalid_request", message);
}

/**
 * Validates the explicit client assertion and returns its canonical DB order.
 * Omission is allowed for already-cleared assets; an empty array has no effect.
 */
export function parseReferenceRightsAttestationsV1(
  value: unknown,
  requestedAssetIds: readonly string[],
  backfill: boolean,
): ReferenceRightsAttestationInputV1[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 16) {
    return invalid("rights_attestations_invalid");
  }
  if (backfill && value.length > 0) {
    return invalid("rights_attestations_not_allowed_for_backfill");
  }

  const requested = new Set(requestedAssetIds.map((id) => id.toLowerCase()));
  const seen = new Set<string>();
  const parsed = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return invalid("rights_attestation_item_invalid");
    }
    const item = raw as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    const assetId = String(item.assetId ?? "").toLowerCase();
    const rightsBasis = String(item.rightsBasis ?? "");
    if (
      keys.join(",") !==
        "assetId,conditioningAuthorized,policyVersion,rightsBasis" ||
      !UUID_RE.test(assetId) || !requested.has(assetId) || seen.has(assetId) ||
      (rightsBasis !== "owned" && rightsBasis !== "licensed") ||
      item.conditioningAuthorized !== true ||
      item.policyVersion !== REFERENCE_RIGHTS_POLICY_VERSION
    ) {
      return invalid("rights_attestation_item_invalid");
    }
    seen.add(assetId);
    return {
      assetId,
      rightsBasis: rightsBasis as ReferenceRightsBasis,
      conditioningAuthorized: true as const,
      policyVersion: REFERENCE_RIGHTS_POLICY_VERSION,
    };
  });
  return parsed.sort((left, right) =>
    left.assetId.localeCompare(right.assetId)
  );
}

export async function attestInspirationAssetRightsV1(
  rpc: RpcInvoker,
  input: {
    profileId: string;
    idempotencyKey: string;
    attestations: readonly ReferenceRightsAttestationInputV1[];
  },
): Promise<RecordedReferenceRightsAttestationV1[]> {
  if (input.attestations.length === 0) return [];
  const result = await rpc("attest_inspiration_asset_rights", {
    p_profile_id: input.profileId,
    p_idempotency_key: input.idempotencyKey,
    p_attestations: input.attestations,
  });
  if (result.error) {
    throw new ReferenceRightsAttestationError(
      "database_error",
      `rights attestation failed: ${result.error.message}`,
      result.error,
    );
  }
  if (
    !Array.isArray(result.data) ||
    result.data.length !== input.attestations.length
  ) {
    throw new ReferenceRightsAttestationError(
      "invalid_rpc_response",
      "rights attestation RPC returned the wrong row count",
    );
  }

  const expected = new Map(
    input.attestations.map((item) => [item.assetId, item]),
  );
  const seen = new Set<string>();
  const rows = result.data.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ReferenceRightsAttestationError(
        "invalid_rpc_response",
        "rights attestation RPC returned an invalid row",
      );
    }
    const row = raw as Record<string, unknown>;
    const assetId = String(row.asset_id ?? "");
    const expectedItem = expected.get(assetId);
    if (
      !expectedItem || seen.has(assetId) ||
      row.rights_basis !== expectedItem.rightsBasis ||
      row.conditioning_authorized !== true ||
      row.policy_version !== expectedItem.policyVersion ||
      !UUID_RE.test(String(row.attestation_id ?? "")) ||
      typeof row.replayed !== "boolean" ||
      typeof row.attested_at !== "string"
    ) {
      throw new ReferenceRightsAttestationError(
        "invalid_rpc_response",
        "rights attestation RPC evidence does not match the request",
      );
    }
    seen.add(assetId);
    return {
      ...expectedItem,
      attestationId: String(row.attestation_id),
      replayed: row.replayed === true,
      attestedAt: row.attested_at,
    };
  });
  return rows.sort((left, right) => left.assetId.localeCompare(right.assetId));
}
