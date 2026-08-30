export type ReferenceIndexStage =
  | "vision"
  | "text_embedding"
  | "visual_embedding";

export interface RpcErrorLike {
  code?: string;
  message: string;
  details?: string;
  hint?: string;
}

export interface RpcResultLike {
  data: unknown;
  error: RpcErrorLike | null;
}

export type RpcInvoker = (
  functionName: string,
  args: Record<string, unknown>,
) => Promise<RpcResultLike>;

export class ReferenceIndexStateError extends Error {
  constructor(
    readonly code:
      | "database_error"
      | "invalid_state_response"
      | "failure_commit_unknown"
      | "result_commit_unknown",
    message: string,
    readonly rpcCause?: RpcErrorLike,
  ) {
    super(message);
    this.name = "ReferenceIndexStateError";
  }
}

function firstRow(data: unknown): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReferenceIndexStateError(
      "invalid_state_response",
      "reference indexing RPC returned no row",
    );
  }
  return value as Record<string, unknown>;
}

function rpcFailure(
  name: string,
  error: RpcErrorLike,
): ReferenceIndexStateError {
  return new ReferenceIndexStateError(
    "database_error",
    `${name} failed: ${error.message}`,
    error,
  );
}

export async function reserveReferenceIndexRun(
  rpc: RpcInvoker,
  input: {
    requestedBy: string;
    idempotencyKey: string;
    requestManifest: Record<string, unknown>;
    indexingVersion: string;
  },
): Promise<{
  runId: string;
  status: string;
  replayed: boolean;
  requestHash: string;
}> {
  const result = await rpc("reserve_reference_index_run", {
    p_requested_by: input.requestedBy,
    p_idempotency_key: input.idempotencyKey,
    p_request_manifest: input.requestManifest,
    p_indexing_version: input.indexingVersion,
  });
  if (result.error) {
    throw rpcFailure("reserve_reference_index_run", result.error);
  }
  const row = firstRow(result.data);
  return {
    runId: String(row.run_id),
    status: String(row.run_status),
    replayed: row.replayed === true,
    requestHash: String(row.request_hash),
  };
}

export async function claimReferenceIndexRun(
  rpc: RpcInvoker,
  input: { runId: string; requestedBy: string },
): Promise<{
  claimed: boolean;
  status: string;
  attemptNumber: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
}> {
  const result = await rpc("claim_reference_index_run", {
    p_run_id: input.runId,
    p_requested_by: input.requestedBy,
    p_lease_seconds: 600,
  });
  if (result.error) throw rpcFailure("claim_reference_index_run", result.error);
  const row = firstRow(result.data);
  return {
    claimed: row.claimed === true,
    status: String(row.run_status),
    attemptNumber: Number(row.attempt_number),
    leaseToken: row.lease_token ? String(row.lease_token) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
  };
}

async function failReferenceIndexRunOnce(
  rpc: RpcInvoker,
  input: {
    runId: string;
    requestedBy: string;
    attemptNumber: number;
    leaseToken: string;
    errorCode: string;
    errorDetail: string;
  },
): Promise<{ failed: boolean; replayed: boolean; status: string }> {
  const result = await rpc("fail_reference_index_run", {
    p_run_id: input.runId,
    p_requested_by: input.requestedBy,
    p_attempt_number: input.attemptNumber,
    p_lease_token: input.leaseToken,
    p_error_code: input.errorCode,
    p_error_detail: input.errorDetail,
  });
  if (result.error) throw rpcFailure("fail_reference_index_run", result.error);
  const row = firstRow(result.data);
  return {
    failed: row.failed === true,
    replayed: row.replayed === true,
    status: String(row.run_status),
  };
}

/** Retries only the identical idempotent database failure transition. */
export async function failReferenceIndexRun(
  rpc: RpcInvoker,
  input: Parameters<typeof failReferenceIndexRunOnce>[1],
): Promise<{ failed: boolean; replayed: boolean; status: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await failReferenceIndexRunOnce(rpc, input);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
      }
    }
  }
  throw new ReferenceIndexStateError(
    "failure_commit_unknown",
    "pre-provider failure database commit is unknown; retry only the same failure payload",
    lastError instanceof ReferenceIndexStateError
      ? lastError.rpcCause
      : undefined,
  );
}

export async function prepareReferenceProviderCall(
  rpc: RpcInvoker,
  input: {
    runId: string;
    requestedBy: string;
    attemptNumber: number;
    leaseToken: string;
    callId: string;
    stage: ReferenceIndexStage;
    callOrdinal: number;
    modelRef: string;
    requestHash: string;
  },
): Promise<{ invokeAllowed: boolean; callId: string; status: string }> {
  const result = await rpc("begin_reference_index_provider_call", {
    p_run_id: input.runId,
    p_requested_by: input.requestedBy,
    p_attempt_number: input.attemptNumber,
    p_lease_token: input.leaseToken,
    p_call_id: input.callId,
    p_stage: input.stage,
    p_call_ordinal: input.callOrdinal,
    p_model_ref: input.modelRef,
    p_request_hash: input.requestHash,
  });
  if (result.error) {
    throw rpcFailure("begin_reference_index_provider_call", result.error);
  }
  const row = firstRow(result.data);
  return {
    invokeAllowed: row.invoke_allowed === true,
    callId: String(row.call_id),
    status: String(row.call_status),
  };
}

export interface StagedProviderResult {
  responsePayload: Record<string, unknown> | readonly unknown[];
  providerRequestId?: string | null;
  inputUnits: number;
  outputUnits: number;
  costMicros: number;
  providerMeta?: Record<string, unknown>;
}

async function recordReferenceProviderResultOnce(
  rpc: RpcInvoker,
  input: {
    runId: string;
    requestedBy: string;
    attemptNumber: number;
    leaseToken: string;
    callId: string;
    result: StagedProviderResult;
  },
): Promise<{ staged: boolean; replayed: boolean; responseHash: string }> {
  const response = await rpc("record_reference_index_provider_result", {
    p_run_id: input.runId,
    p_requested_by: input.requestedBy,
    p_attempt_number: input.attemptNumber,
    p_lease_token: input.leaseToken,
    p_call_id: input.callId,
    p_response_payload: input.result.responsePayload,
    p_provider_request_id: input.result.providerRequestId ?? null,
    p_input_units: input.result.inputUnits,
    p_output_units: input.result.outputUnits,
    p_cost_micros: input.result.costMicros,
    p_provider_meta: input.result.providerMeta ?? {},
  });
  if (response.error) {
    throw rpcFailure("record_reference_index_provider_result", response.error);
  }
  const row = firstRow(response.data);
  return {
    staged: row.staged === true,
    replayed: row.replayed === true,
    responseHash: String(row.response_hash),
  };
}

/**
 * Retries only the same database payload. The caller must retain the normalized
 * provider response in memory and must never re-issue the provider HTTP call.
 */
export async function recordReferenceProviderResultDurably(
  rpc: RpcInvoker,
  input: Parameters<typeof recordReferenceProviderResultOnce>[1],
): Promise<{ staged: boolean; replayed: boolean; responseHash: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await recordReferenceProviderResultOnce(rpc, input);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
      }
    }
  }
  throw new ReferenceIndexStateError(
    "result_commit_unknown",
    "provider returned a result but its durable database commit is unknown; do not call the provider again",
    lastError instanceof ReferenceIndexStateError
      ? lastError.rpcCause
      : undefined,
  );
}

export async function recordReferenceProviderFailure(
  rpc: RpcInvoker,
  input: {
    runId: string;
    requestedBy: string;
    attemptNumber: number;
    leaseToken: string;
    callId: string;
    outcome: "rejected" | "failed" | "indeterminate";
    errorCode: string;
    errorDetail: string;
    providerRequestId?: string | null;
  },
): Promise<string> {
  const result = await rpc("record_reference_index_provider_failure", {
    p_run_id: input.runId,
    p_requested_by: input.requestedBy,
    p_attempt_number: input.attemptNumber,
    p_lease_token: input.leaseToken,
    p_call_id: input.callId,
    p_outcome: input.outcome,
    p_error_code: input.errorCode,
    p_error_detail: input.errorDetail,
    p_provider_request_id: input.providerRequestId ?? null,
  });
  if (result.error) {
    throw rpcFailure("record_reference_index_provider_failure", result.error);
  }
  return String(result.data);
}

export async function getReferenceIndexRunState(
  rpc: RpcInvoker,
  input: { runId: string; requestedBy: string },
): Promise<Record<string, unknown>> {
  const result = await rpc("get_reference_index_run_state", {
    p_run_id: input.runId,
    p_requested_by: input.requestedBy,
  });
  if (result.error) {
    throw rpcFailure("get_reference_index_run_state", result.error);
  }
  return firstRow(result.data);
}

export async function completeReferenceIndexRun(
  rpc: RpcInvoker,
  input: {
    runId: string;
    requestedBy: string;
    attemptNumber: number;
    leaseToken: string;
  },
): Promise<{ completed: boolean; replayed: boolean }> {
  const result = await rpc("complete_reference_index_run", {
    p_run_id: input.runId,
    p_requested_by: input.requestedBy,
    p_attempt_number: input.attemptNumber,
    p_lease_token: input.leaseToken,
  });
  if (result.error) {
    throw rpcFailure("complete_reference_index_run", result.error);
  }
  const row = firstRow(result.data);
  return { completed: row.completed === true, replayed: row.replayed === true };
}

export interface ReapedReferenceIndexWork {
  workKind: string;
  workId: string;
  previousStatus: string;
  resultingStatus: string;
}

/**
 * Performs one bounded service-role recovery sweep. This function does not
 * schedule itself; callers must invoke it from a trusted worker or a bounded
 * opportunistic request path.
 */
export async function reapStaleReferenceIndexWork(
  rpc: RpcInvoker,
  input: { limit: number; reservationGraceSeconds: number },
): Promise<ReapedReferenceIndexWork[]> {
  const result = await rpc("reap_stale_reference_index_work", {
    p_limit: input.limit,
    p_reservation_grace_seconds: input.reservationGraceSeconds,
  });
  if (result.error) {
    throw rpcFailure("reap_stale_reference_index_work", result.error);
  }
  if (!Array.isArray(result.data)) {
    throw new ReferenceIndexStateError(
      "invalid_state_response",
      "reference indexing reaper returned a non-array response",
    );
  }
  return result.data.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ReferenceIndexStateError(
        "invalid_state_response",
        "reference indexing reaper returned an invalid row",
      );
    }
    const row = value as Record<string, unknown>;
    return {
      workKind: String(row.work_kind),
      workId: String(row.work_id),
      previousStatus: String(row.previous_status),
      resultingStatus: String(row.resulting_status),
    };
  });
}
