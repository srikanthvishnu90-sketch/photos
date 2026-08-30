export type EditJobStatus =
  | "reserved"
  | "processing"
  | "provider_prepared"
  | "result_captured"
  | "delivered"
  | "failed"
  | "indeterminate";

export type EditQuotaState = "held" | "charged" | "released";
export type EditProviderCallStatus =
  | "prepared"
  | "succeeded"
  | "rejected"
  | "failed"
  | "indeterminate";
export type EditOutputMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface EditRpcErrorLike {
  code?: string;
  message: string;
  details?: string;
  hint?: string;
}

export interface EditRpcResultLike {
  data: unknown;
  error: EditRpcErrorLike | null;
}

export type EditRpcInvoker = (
  functionName: string,
  args: Record<string, unknown>,
) => Promise<EditRpcResultLike>;

export class EditGenerationStateError extends Error {
  constructor(
    readonly code:
      | "database_error"
      | "invalid_request"
      | "invalid_rpc_response"
      | "provider_preparation_unknown"
      | "result_commit_unknown"
      | "failure_commit_unknown"
      | "settlement_commit_unknown",
    message: string,
    readonly rpcCause?: EditRpcErrorLike,
  ) {
    super(message);
    this.name = "EditGenerationStateError";
  }
}

export interface EditRequestManifestV1 {
  schema: "edit-request-v1";
  provider: string;
  modelRef: string;
  promptVersion: string;
  kind: string;
  photoId: string | null;
  style: string | null;
  inputSha256: string;
  instructionSha256: string;
  hasMask: boolean;
  maskSha256: string | null;
}

interface EditProviderResultCommonV1 {
  schema: "edit-provider-result-v1";
  providerRequestId: string | null;
  outputStorageBucket: "edits";
  outputStoragePath: string;
  outputMimeType: EditOutputMimeType;
  outputByteSize: number;
  outputSha256: string;
  width: number | null;
  height: number | null;
  inputUnits: number;
  outputUnits: number;
}

export type EditProviderResultManifestV1 =
  | (EditProviderResultCommonV1 & {
    costMicros: number;
    billingState: "reported";
    providerMeta: Record<string, unknown> & { pricingStatus: "priced" };
  })
  | (EditProviderResultCommonV1 & {
    costMicros: null;
    billingState: "unknown";
    providerMeta: Record<string, unknown> & { pricingStatus: "unpriced" };
  });

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function invalidRequest(message: string): never {
  throw new EditGenerationStateError("invalid_request", message);
}

function assertHash(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) invalidRequest(`${field}_invalid`);
}

export function buildEditRequestManifestV1(input: {
  provider: string;
  modelRef: string;
  promptVersion: string;
  kind: string;
  photoId?: string | null;
  style?: string | null;
  inputSha256: string;
  instructionSha256: string;
  maskSha256?: string | null;
}): EditRequestManifestV1 {
  assertHash(input.inputSha256, "input_sha256");
  assertHash(input.instructionSha256, "instruction_sha256");
  if (input.maskSha256 != null) assertHash(input.maskSha256, "mask_sha256");
  if (!input.provider || !input.modelRef || !input.promptVersion || !input.kind) {
    invalidRequest("edit_manifest_metadata_missing");
  }
  return {
    schema: "edit-request-v1",
    provider: input.provider,
    modelRef: input.modelRef,
    promptVersion: input.promptVersion,
    kind: input.kind,
    photoId: input.photoId ?? null,
    style: input.style ?? null,
    inputSha256: input.inputSha256,
    instructionSha256: input.instructionSha256,
    hasMask: input.maskSha256 != null,
    maskSha256: input.maskSha256 ?? null,
  };
}

export function editOutputStoragePathV1(
  profileId: string,
  jobId: string,
  mimeType: EditOutputMimeType,
): string {
  const extension = mimeType === "image/jpeg"
    ? "jpg"
    : mimeType === "image/png"
    ? "png"
    : "webp";
  return `${profileId}/edit/${jobId}/output.${extension}`;
}

function rpcFailure(name: string, error: EditRpcErrorLike) {
  return new EditGenerationStateError(
    "database_error",
    `${name} failed: ${error.message}`,
    error,
  );
}

function firstRow(data: unknown, name: string): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EditGenerationStateError(
      "invalid_rpc_response",
      `${name} returned no row`,
    );
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EditGenerationStateError(
      "invalid_rpc_response",
      `${field} is missing`,
    );
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value == null) return null;
  return stringValue(value, field);
}

function integerValue(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(number)) {
    throw new EditGenerationStateError(
      "invalid_rpc_response",
      `${field} is not an integer`,
    );
  }
  return number;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new EditGenerationStateError(
      "invalid_rpc_response",
      `${field} is invalid`,
    );
  }
  return value as T;
}

const JOB_STATUSES: readonly EditJobStatus[] = [
  "reserved",
  "processing",
  "provider_prepared",
  "result_captured",
  "delivered",
  "failed",
  "indeterminate",
];
const QUOTA_STATES: readonly EditQuotaState[] = ["held", "charged", "released"];
const CALL_STATUSES: readonly EditProviderCallStatus[] = [
  "prepared",
  "succeeded",
  "rejected",
  "failed",
  "indeterminate",
];

export interface ReservedEditGenerationV1 {
  jobId: string;
  jobStatus: EditJobStatus;
  replayed: boolean;
  requestHash: string;
  quotaState: EditQuotaState;
  planSnapshot: "free" | "plus";
  quotaPeriodStart: string;
  outputStoragePaths: string[];
}

export async function reserveEditGenerationV1(
  rpc: EditRpcInvoker,
  input: {
    profileId: string;
    idempotencyKey: string;
    requestManifest: EditRequestManifestV1;
  },
): Promise<ReservedEditGenerationV1> {
  const response = await rpc("reserve_edit_generation", {
    p_profile_id: input.profileId,
    p_idempotency_key: input.idempotencyKey,
    p_request_manifest: input.requestManifest,
  });
  if (response.error) throw rpcFailure("reserve_edit_generation", response.error);
  const row = firstRow(response.data, "reserve_edit_generation");
  if (!Array.isArray(row.output_storage_paths)) {
    throw new EditGenerationStateError(
      "invalid_rpc_response",
      "output_storage_paths is invalid",
    );
  }
  return {
    jobId: stringValue(row.job_id, "job_id"),
    jobStatus: enumValue(row.job_status, JOB_STATUSES, "job_status"),
    replayed: row.replayed === true,
    requestHash: stringValue(row.request_hash, "request_hash"),
    quotaState: enumValue(row.quota_state, QUOTA_STATES, "quota_state"),
    planSnapshot: enumValue(row.plan_snapshot, ["free", "plus"], "plan_snapshot"),
    quotaPeriodStart: stringValue(row.quota_period_start, "quota_period_start"),
    outputStoragePaths: row.output_storage_paths.map((value) =>
      stringValue(value, "output_storage_path")
    ),
  };
}

export interface ClaimedEditGenerationV1 {
  claimed: boolean;
  replayed: boolean;
  jobStatus: EditJobStatus;
  attemptNumber: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
}

export async function claimEditGenerationV1(
  rpc: EditRpcInvoker,
  input: { jobId: string; profileId: string; leaseToken: string },
): Promise<ClaimedEditGenerationV1> {
  const response = await rpc("claim_edit_generation", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_lease_token: input.leaseToken,
  });
  if (response.error) throw rpcFailure("claim_edit_generation", response.error);
  const row = firstRow(response.data, "claim_edit_generation");
  return {
    claimed: row.claimed === true,
    replayed: row.replayed === true,
    jobStatus: enumValue(row.job_status, JOB_STATUSES, "job_status"),
    attemptNumber: integerValue(row.attempt_number, "attempt_number"),
    leaseToken: nullableString(row.lease_token, "lease_token"),
    leaseExpiresAt: nullableString(row.lease_expires_at, "lease_expires_at"),
  };
}

/**
 * This call is intentionally never retried here. Only an initial
 * `invokeAllowed: true` response authorizes exactly one provider HTTP call.
 * A lost/errored response is indeterminate and must never trigger provider
 * HTTP; retrying later can only return `invokeAllowed: false`.
 */
export async function beginEditProviderCallV1(
  rpc: EditRpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptNumber: number;
    leaseToken: string;
    callId: string;
    requestHash: string;
  },
): Promise<{
  invokeAllowed: boolean;
  callId: string;
  callStatus: EditProviderCallStatus;
  jobStatus: EditJobStatus;
}> {
  const response = await rpc("begin_edit_provider_call", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_number: input.attemptNumber,
    p_lease_token: input.leaseToken,
    p_call_id: input.callId,
    p_request_hash: input.requestHash,
  });
  if (response.error) {
    throw new EditGenerationStateError(
      "provider_preparation_unknown",
      `begin_edit_provider_call failed: ${response.error.message}; do not invoke the provider`,
      response.error,
    );
  }
  const row = firstRow(response.data, "begin_edit_provider_call");
  return {
    invokeAllowed: row.invoke_allowed === true,
    callId: stringValue(row.call_id, "call_id"),
    callStatus: enumValue(row.call_status, CALL_STATUSES, "call_status"),
    jobStatus: enumValue(row.job_status, JOB_STATUSES, "job_status"),
  };
}

export interface CapturedEditResultV1 {
  captured: boolean;
  replayed: boolean;
  jobStatus: EditJobStatus;
  resultHash: string;
}

async function recordEditProviderResultOnceV1(
  rpc: EditRpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptNumber: number;
    leaseToken: string;
    callId: string;
    resultManifest: EditProviderResultManifestV1;
  },
): Promise<CapturedEditResultV1> {
  const response = await rpc("record_edit_provider_result", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_number: input.attemptNumber,
    p_lease_token: input.leaseToken,
    p_call_id: input.callId,
    p_result_manifest: input.resultManifest,
  });
  if (response.error) {
    throw rpcFailure("record_edit_provider_result", response.error);
  }
  const row = firstRow(response.data, "record_edit_provider_result");
  return {
    captured: row.captured === true,
    replayed: row.replayed === true,
    jobStatus: enumValue(row.job_status, JOB_STATUSES, "job_status"),
    resultHash: stringValue(row.result_hash, "result_hash"),
  };
}

async function retrySameDatabasePayload<T>(
  operation: () => Promise<T>,
  unknownCode:
    | "result_commit_unknown"
    | "failure_commit_unknown"
    | "settlement_commit_unknown",
  unknownMessage: string,
): Promise<T> {
  let lastError: EditGenerationStateError | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof EditGenerationStateError) ||
        error.code !== "database_error") {
        throw error;
      }
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  throw new EditGenerationStateError(
    unknownCode,
    unknownMessage,
    lastError?.rpcCause,
  );
}

/** Retries only the byte-for-byte identical DB payload, never provider HTTP. */
export function recordEditProviderResultDurablyV1(
  rpc: EditRpcInvoker,
  input: Parameters<typeof recordEditProviderResultOnceV1>[1],
): Promise<CapturedEditResultV1> {
  return retrySameDatabasePayload(
    () => recordEditProviderResultOnceV1(rpc, input),
    "result_commit_unknown",
    "edit provider result commit is unknown; preserve the deterministic object and never call the provider again",
  );
}

export async function recoverEditProviderResultV1(
  rpc: EditRpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    callId: string;
    resultManifest: EditProviderResultManifestV1;
  },
): Promise<CapturedEditResultV1> {
  const response = await rpc("recover_edit_provider_result", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_call_id: input.callId,
    p_result_manifest: input.resultManifest,
  });
  if (response.error) {
    throw rpcFailure("recover_edit_provider_result", response.error);
  }
  const row = firstRow(response.data, "recover_edit_provider_result");
  return {
    captured: row.captured === true,
    replayed: row.replayed === true,
    jobStatus: enumValue(row.job_status, JOB_STATUSES, "job_status"),
    resultHash: stringValue(row.result_hash, "result_hash"),
  };
}

export interface FailedEditGenerationV1 {
  failed: boolean;
  replayed: boolean;
  jobStatus: EditJobStatus;
  quotaState: EditQuotaState;
}

export async function failEditGenerationPreProviderV1(
  rpc: EditRpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptNumber: number;
    leaseToken: string;
    errorCode: string;
    errorDetail: string;
  },
): Promise<FailedEditGenerationV1> {
  const response = await rpc("fail_edit_generation_pre_provider", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_number: input.attemptNumber,
    p_lease_token: input.leaseToken,
    p_error_code: input.errorCode,
    p_error_detail: input.errorDetail,
  });
  if (response.error) {
    throw rpcFailure("fail_edit_generation_pre_provider", response.error);
  }
  const row = firstRow(response.data, "fail_edit_generation_pre_provider");
  return {
    failed: row.failed === true,
    replayed: row.replayed === true,
    jobStatus: enumValue(row.job_status, JOB_STATUSES, "job_status"),
    quotaState: enumValue(row.quota_state, QUOTA_STATES, "quota_state"),
  };
}

export interface RecordedEditProviderFailureV1 {
  recorded: boolean;
  replayed: boolean;
  jobStatus: EditJobStatus;
  callStatus: EditProviderCallStatus;
  quotaState: EditQuotaState;
}

async function recordEditProviderFailureOnceV1(
  rpc: EditRpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    attemptNumber: number;
    leaseToken: string;
    callId: string;
    outcome: "rejected" | "failed" | "indeterminate";
    errorCode: string;
    errorDetail: string;
    providerRequestId?: string | null;
  },
): Promise<RecordedEditProviderFailureV1> {
  const response = await rpc("record_edit_provider_failure", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_attempt_number: input.attemptNumber,
    p_lease_token: input.leaseToken,
    p_call_id: input.callId,
    p_outcome: input.outcome,
    p_error_code: input.errorCode,
    p_error_detail: input.errorDetail,
    p_provider_request_id: input.providerRequestId ?? null,
  });
  if (response.error) {
    throw rpcFailure("record_edit_provider_failure", response.error);
  }
  const row = firstRow(response.data, "record_edit_provider_failure");
  return {
    recorded: row.recorded === true,
    replayed: row.replayed === true,
    jobStatus: enumValue(row.job_status, JOB_STATUSES, "job_status"),
    callStatus: enumValue(row.call_status, CALL_STATUSES, "call_status"),
    quotaState: enumValue(row.quota_state, QUOTA_STATES, "quota_state"),
  };
}

/** Retries only the same terminal evidence; it never retries provider HTTP. */
export function recordEditProviderFailureDurablyV1(
  rpc: EditRpcInvoker,
  input: Parameters<typeof recordEditProviderFailureOnceV1>[1],
): Promise<RecordedEditProviderFailureV1> {
  return retrySameDatabasePayload(
    () => recordEditProviderFailureOnceV1(rpc, input),
    "failure_commit_unknown",
    "edit provider failure commit is unknown; retry only this identical evidence",
  );
}

export interface SettledEditGenerationV1 {
  delivered: boolean;
  replayed: boolean;
  jobStatus: EditJobStatus;
  quotaState: EditQuotaState;
  tasteEventId: string;
}

async function settleEditGenerationOnceV1(
  rpc: EditRpcInvoker,
  input: {
    jobId: string;
    profileId: string;
    outputStoragePath: string;
    outputSha256: string;
  },
): Promise<SettledEditGenerationV1> {
  const response = await rpc("settle_edit_generation", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
    p_output_storage_path: input.outputStoragePath,
    p_output_sha256: input.outputSha256,
  });
  if (response.error) throw rpcFailure("settle_edit_generation", response.error);
  const row = firstRow(response.data, "settle_edit_generation");
  return {
    delivered: row.delivered === true,
    replayed: row.replayed === true,
    jobStatus: enumValue(row.job_status, JOB_STATUSES, "job_status"),
    quotaState: enumValue(row.quota_state, QUOTA_STATES, "quota_state"),
    tasteEventId: stringValue(row.taste_event_id, "taste_event_id"),
  };
}

/** Atomic taste-event insert + quota charge + delivery, replayed on DB errors. */
export function settleEditGenerationDurablyV1(
  rpc: EditRpcInvoker,
  input: Parameters<typeof settleEditGenerationOnceV1>[1],
): Promise<SettledEditGenerationV1> {
  return retrySameDatabasePayload(
    () => settleEditGenerationOnceV1(rpc, input),
    "settlement_commit_unknown",
    "edit settlement commit is unknown; retry only the same storage path and hash",
  );
}

export async function releaseIndeterminateEditGenerationV1(
  rpc: EditRpcInvoker,
  input: { jobId: string; profileId: string },
): Promise<{
  released: boolean;
  replayed: boolean;
  jobStatus: EditJobStatus;
  quotaState: EditQuotaState;
}> {
  const response = await rpc("release_indeterminate_edit_generation", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
  });
  if (response.error) {
    throw rpcFailure("release_indeterminate_edit_generation", response.error);
  }
  const row = firstRow(response.data, "release_indeterminate_edit_generation");
  return {
    released: row.released === true,
    replayed: row.replayed === true,
    jobStatus: enumValue(row.job_status, JOB_STATUSES, "job_status"),
    quotaState: enumValue(row.quota_state, QUOTA_STATES, "quota_state"),
  };
}

export interface EditGenerationStateV1 {
  jobId: string;
  status: EditJobStatus;
  requestHash: string;
  attemptNumber: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  outputStoragePath: string | null;
  outputMimeType: string | null;
  outputSha256: string | null;
  resultHash: string | null;
  errorCode: string | null;
  quota: {
    state: EditQuotaState;
    periodStart: string;
    planSnapshot: "free" | "plus";
    freeLimitSnapshot: number;
  };
  providerCall: null | {
    id: string;
    status: EditProviderCallStatus;
    attemptNumber: number;
    requestHash: string;
    resultHash: string | null;
    billingState: "pending" | "reported" | "not_billable" | "unknown";
    errorCode: string | null;
  };
  outputStoragePaths: string[];
}

export async function getEditGenerationStateV1(
  rpc: EditRpcInvoker,
  input: { jobId: string; profileId: string },
): Promise<EditGenerationStateV1> {
  const response = await rpc("get_edit_generation_state", {
    p_job_id: input.jobId,
    p_profile_id: input.profileId,
  });
  if (response.error) {
    throw rpcFailure("get_edit_generation_state", response.error);
  }
  const row = firstRow(response.data, "get_edit_generation_state");
  const quota = firstRow(row.quota, "edit quota state");
  const providerCall = row.providerCall == null
    ? null
    : firstRow(row.providerCall, "edit provider-call state");
  if (!Array.isArray(row.outputStoragePaths)) {
    throw new EditGenerationStateError(
      "invalid_rpc_response",
      "outputStoragePaths is invalid",
    );
  }
  return {
    jobId: stringValue(row.jobId, "jobId"),
    status: enumValue(row.status, JOB_STATUSES, "status"),
    requestHash: stringValue(row.requestHash, "requestHash"),
    attemptNumber: integerValue(row.attemptNumber, "attemptNumber"),
    leaseToken: nullableString(row.leaseToken, "leaseToken"),
    leaseExpiresAt: nullableString(row.leaseExpiresAt, "leaseExpiresAt"),
    outputStoragePath: nullableString(row.outputStoragePath, "outputStoragePath"),
    outputMimeType: nullableString(row.outputMimeType, "outputMimeType"),
    outputSha256: nullableString(row.outputSha256, "outputSha256"),
    resultHash: nullableString(row.resultHash, "resultHash"),
    errorCode: nullableString(row.errorCode, "errorCode"),
    quota: {
      state: enumValue(quota.state, QUOTA_STATES, "quota.state"),
      periodStart: stringValue(quota.periodStart, "quota.periodStart"),
      planSnapshot: enumValue(
        quota.planSnapshot,
        ["free", "plus"],
        "quota.planSnapshot",
      ),
      freeLimitSnapshot: integerValue(
        quota.freeLimitSnapshot,
        "quota.freeLimitSnapshot",
      ),
    },
    providerCall: providerCall == null
      ? null
      : {
        id: stringValue(providerCall.id, "providerCall.id"),
        status: enumValue(
          providerCall.status,
          CALL_STATUSES,
          "providerCall.status",
        ),
        attemptNumber: integerValue(
          providerCall.attemptNumber,
          "providerCall.attemptNumber",
        ),
        requestHash: stringValue(
          providerCall.requestHash,
          "providerCall.requestHash",
        ),
        resultHash: nullableString(
          providerCall.resultHash,
          "providerCall.resultHash",
        ),
        billingState: enumValue(
          providerCall.billingState,
          ["pending", "reported", "not_billable", "unknown"],
          "providerCall.billingState",
        ),
        errorCode: nullableString(
          providerCall.errorCode,
          "providerCall.errorCode",
        ),
      },
    outputStoragePaths: row.outputStoragePaths.map((value) =>
      stringValue(value, "outputStoragePath")
    ),
  };
}

export async function reapStaleEditGenerationV1(
  rpc: EditRpcInvoker,
  limit = 25,
): Promise<Array<{
  jobId: string;
  priorStatus: EditJobStatus;
  resultingStatus: EditJobStatus;
  quotaState: EditQuotaState;
  action: string;
  outputStoragePaths: string[];
}>> {
  const response = await rpc("reap_stale_edit_generation", { p_limit: limit });
  if (response.error) {
    throw rpcFailure("reap_stale_edit_generation", response.error);
  }
  if (!Array.isArray(response.data)) {
    throw new EditGenerationStateError(
      "invalid_rpc_response",
      "reap_stale_edit_generation returned a non-array response",
    );
  }
  return response.data.map((value) => {
    const row = firstRow(value, "reap_stale_edit_generation row");
    if (!Array.isArray(row.output_storage_paths)) {
      throw new EditGenerationStateError(
        "invalid_rpc_response",
        "reaper output_storage_paths is invalid",
      );
    }
    return {
      jobId: stringValue(row.job_id, "job_id"),
      priorStatus: enumValue(row.prior_status, JOB_STATUSES, "prior_status"),
      resultingStatus: enumValue(
        row.resulting_status,
        JOB_STATUSES,
        "resulting_status",
      ),
      quotaState: enumValue(row.quota_state, QUOTA_STATES, "quota_state"),
      action: stringValue(row.action, "action"),
      outputStoragePaths: row.output_storage_paths.map((path) =>
        stringValue(path, "output_storage_path")
      ),
    };
  });
}
