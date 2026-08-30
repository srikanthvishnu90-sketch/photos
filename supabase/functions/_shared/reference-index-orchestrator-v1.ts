/**
 * Durable provider-stage orchestration for reference indexing.
 *
 * The database owns leases and one immutable provider-call row per
 * (run, stage, ordinal). This module is deliberately provider-agnostic. The
 * supplied `invokeOnce` callback is called at most once and is never wrapped in
 * a retry. Only the exact same RPC result payload may be retried by the state
 * client after provider HTTP has returned.
 */
import {
  failReferenceIndexRun,
  getReferenceIndexRunState,
  prepareReferenceProviderCall,
  recordReferenceProviderFailure,
  recordReferenceProviderResultDurably,
  type ReferenceIndexStage,
  type RpcInvoker,
  type StagedProviderResult,
} from "./reference-index-state-client-v1.ts";

export type ReferenceIndexJson =
  | null
  | boolean
  | number
  | string
  | readonly ReferenceIndexJson[]
  | { readonly [key: string]: ReferenceIndexJson };

export type ReferenceIndexResponsePayload =
  | Record<string, unknown>
  | readonly unknown[];

export interface ReferenceIndexProviderInvocationV1<T> {
  readonly value: T;
  readonly ledger: StagedProviderResult;
}

export interface ReferenceIndexProviderFailureV1 {
  readonly outcome: "rejected" | "failed" | "indeterminate";
  readonly errorCode: string;
  readonly errorDetail: string;
  readonly providerRequestId?: string | null;
}

export interface ReferenceIndexProviderStageInputV1<T> {
  readonly rpc: RpcInvoker;
  readonly runId: string;
  readonly requestedBy: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
  readonly stage: ReferenceIndexStage;
  readonly callOrdinal: number;
  readonly modelRef: string;
  readonly requestHash: string;
  readonly createCallId: () => string;
  /** Performs exactly one provider HTTP attempt. Never add transport retries. */
  readonly invokeOnce: () => Promise<ReferenceIndexProviderInvocationV1<T>>;
  /** Validates and decodes a previously staged normalized response. */
  readonly decodeResponse: (payload: ReferenceIndexResponsePayload) => T;
  readonly classifyFailure: (error: unknown) => ReferenceIndexProviderFailureV1;
}

export interface ReferenceIndexProviderStageResultV1<T> {
  readonly value: T;
  readonly callId: string;
  readonly replayed: boolean;
  readonly responseHash: string | null;
}

export class ReferenceIndexOrchestratorError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_run_state"
      | "provider_call_contract_mismatch"
      | "provider_call_recovery_required"
      | "provider_call_terminal"
      | "provider_failure_commit_unknown"
      | "provider_result_commit_unknown",
    message: string,
    readonly providerMayHaveRun: boolean,
    readonly causeValue?: unknown,
  ) {
    super(message);
    this.name = "ReferenceIndexOrchestratorError";
  }
}

interface ProviderCallStateV1 {
  readonly id: string;
  readonly stage: ReferenceIndexStage;
  readonly callOrdinal: number;
  readonly status: string;
  readonly modelRef: string;
  readonly requestHash: string;
  readonly responsePayload?: ReferenceIndexResponsePayload;
  readonly responseHash?: string | null;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FailClaimedReferenceIndexRunInputV1 {
  readonly rpc: RpcInvoker;
  readonly runId: string;
  readonly requestedBy: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
  readonly errorCode: string;
  readonly errorDetail: string;
}

export type FailClaimedReferenceIndexRunResultV1 =
  | {
    readonly disposition: "failed" | "replayed";
    readonly status: string;
  }
  | {
    readonly disposition: "not_applicable";
    readonly status: string;
    readonly reason:
      | "provider_call_exists"
      | "run_not_active"
      | "attempt_or_lease_changed";
  };

function assertStageInput<T>(
  input: ReferenceIndexProviderStageInputV1<T>,
): void {
  if (
    !UUID_RE.test(input.runId) || !UUID_RE.test(input.requestedBy) ||
    !UUID_RE.test(input.leaseToken) ||
    !Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1 ||
    !Number.isSafeInteger(input.callOrdinal) ||
    input.callOrdinal < 0 || input.callOrdinal > 2 ||
    !input.modelRef || input.modelRef.length > 200 ||
    !SHA256_RE.test(input.requestHash)
  ) {
    throw new ReferenceIndexOrchestratorError(
      "invalid_input",
      "reference provider stage input is invalid",
      false,
    );
  }
}

function canonicalize(value: ReferenceIndexJson): string {
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical_json_number_invalid");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as { readonly [key: string]: ReferenceIndexJson };
  return `{${
    Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(object[key])}`
    ).join(",")
  }}`;
}

export function canonicalReferenceIndexJsonV1(
  value: ReferenceIndexJson,
): string {
  return canonicalize(value);
}

export async function sha256ReferenceIndexJsonV1(
  value: ReferenceIndexJson,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalReferenceIndexJsonV1(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseCalls(state: Record<string, unknown>): ProviderCallStateV1[] {
  if (!Array.isArray(state.calls)) {
    throw new ReferenceIndexOrchestratorError(
      "invalid_run_state",
      "reference indexing state contains no provider call list",
      false,
    );
  }
  return state.calls.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ReferenceIndexOrchestratorError(
        "invalid_run_state",
        "reference indexing state contains an invalid provider call",
        false,
      );
    }
    const row = value as Record<string, unknown>;
    return {
      id: String(row.id ?? ""),
      stage: String(row.stage ?? "") as ReferenceIndexStage,
      callOrdinal: Number(row.callOrdinal),
      status: String(row.status ?? ""),
      modelRef: String(row.modelRef ?? ""),
      requestHash: String(row.requestHash ?? ""),
      responsePayload: row.responsePayload as
        | ReferenceIndexResponsePayload
        | undefined,
      responseHash: row.responseHash == null ? null : String(row.responseHash),
    };
  });
}

/**
 * Fails a claimed run only when a fresh durable read proves that no provider
 * call row exists. The SQL RPC repeats that assertion under the run lock, so a
 * late/unknown call reservation cannot race this transition.
 */
export async function failClaimedReferenceIndexRunBeforeProviderV1(
  input: FailClaimedReferenceIndexRunInputV1,
): Promise<FailClaimedReferenceIndexRunResultV1> {
  if (
    !UUID_RE.test(input.runId) || !UUID_RE.test(input.requestedBy) ||
    !UUID_RE.test(input.leaseToken) ||
    !Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1 ||
    !input.errorCode || input.errorCode.length > 100 ||
    input.errorDetail.length > 1_000
  ) {
    throw new ReferenceIndexOrchestratorError(
      "invalid_input",
      "pre-provider reference failure input is invalid",
      false,
    );
  }

  const state = await getReferenceIndexRunState(input.rpc, {
    runId: input.runId,
    requestedBy: input.requestedBy,
  });
  const status = String(state.status ?? "");
  if (parseCalls(state).length > 0) {
    return {
      disposition: "not_applicable",
      status,
      reason: "provider_call_exists",
    };
  }

  const stateAttempt = Number(state.attemptNumber);
  const stateLease = state.leaseToken == null ? null : String(state.leaseToken);
  if (status === "processing") {
    if (
      stateAttempt !== input.attemptNumber || stateLease !== input.leaseToken
    ) {
      return {
        disposition: "not_applicable",
        status,
        reason: "attempt_or_lease_changed",
      };
    }
  } else if (status === "failed") {
    if (stateAttempt !== input.attemptNumber) {
      return {
        disposition: "not_applicable",
        status,
        reason: "attempt_or_lease_changed",
      };
    }
  } else {
    return { disposition: "not_applicable", status, reason: "run_not_active" };
  }

  const failed = await failReferenceIndexRun(input.rpc, input);
  return {
    disposition: failed.replayed ? "replayed" : "failed",
    status: failed.status,
  };
}

function matchingCall<T>(
  input: ReferenceIndexProviderStageInputV1<T>,
  state: Record<string, unknown>,
): ProviderCallStateV1 | null {
  const matches = parseCalls(state).filter((call) =>
    call.stage === input.stage && call.callOrdinal === input.callOrdinal
  );
  if (matches.length > 1) {
    throw new ReferenceIndexOrchestratorError(
      "invalid_run_state",
      "reference indexing state contains duplicate provider calls",
      false,
    );
  }
  const call = matches[0] ?? null;
  if (
    call &&
    (call.modelRef !== input.modelRef || call.requestHash !== input.requestHash)
  ) {
    throw new ReferenceIndexOrchestratorError(
      "provider_call_contract_mismatch",
      "stored provider call does not match the canonical request",
      call.status !== "rejected",
    );
  }
  return call;
}

function recoverCall<T>(
  input: ReferenceIndexProviderStageInputV1<T>,
  call: ProviderCallStateV1,
): ReferenceIndexProviderStageResultV1<T> {
  if (call.status === "succeeded") {
    if (!call.responsePayload) {
      throw new ReferenceIndexOrchestratorError(
        "invalid_run_state",
        "succeeded provider call has no staged response payload",
        true,
      );
    }
    return {
      value: input.decodeResponse(call.responsePayload),
      callId: call.id,
      replayed: true,
      responseHash: call.responseHash ?? null,
    };
  }
  if (call.status === "prepared") {
    throw new ReferenceIndexOrchestratorError(
      "provider_call_recovery_required",
      "a prepared provider call exists without a durable result; provider HTTP replay is forbidden",
      true,
    );
  }
  throw new ReferenceIndexOrchestratorError(
    "provider_call_terminal",
    `provider call is terminal with status ${call.status}`,
    call.status !== "rejected",
  );
}

function validateLedger(result: StagedProviderResult): void {
  for (
    const value of [result.inputUnits, result.outputUnits, result.costMicros]
  ) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ReferenceIndexOrchestratorError(
        "invalid_input",
        "provider ledger contains an invalid non-negative integer",
        true,
      );
    }
  }
  if (!result.responsePayload || typeof result.responsePayload !== "object") {
    throw new ReferenceIndexOrchestratorError(
      "invalid_input",
      "provider ledger contains no normalized response payload",
      true,
    );
  }
}

/**
 * Runs or recovers one provider stage. Existing succeeded calls are decoded
 * from PostgreSQL; existing prepared calls are never sent to the provider.
 */
export async function runReferenceIndexProviderStageV1<T>(
  input: ReferenceIndexProviderStageInputV1<T>,
): Promise<ReferenceIndexProviderStageResultV1<T>> {
  assertStageInput(input);
  let state = await getReferenceIndexRunState(input.rpc, {
    runId: input.runId,
    requestedBy: input.requestedBy,
  });
  const existing = matchingCall(input, state);
  if (existing) return recoverCall(input, existing);

  const requestedCallId = input.createCallId();
  if (!UUID_RE.test(requestedCallId)) {
    throw new ReferenceIndexOrchestratorError(
      "invalid_input",
      "provider call id is invalid",
      false,
    );
  }
  const prepared = await prepareReferenceProviderCall(input.rpc, {
    runId: input.runId,
    requestedBy: input.requestedBy,
    attemptNumber: input.attemptNumber,
    leaseToken: input.leaseToken,
    callId: requestedCallId,
    stage: input.stage,
    callOrdinal: input.callOrdinal,
    modelRef: input.modelRef,
    requestHash: input.requestHash,
  });
  if (!prepared.invokeAllowed) {
    state = await getReferenceIndexRunState(input.rpc, {
      runId: input.runId,
      requestedBy: input.requestedBy,
    });
    const raced = matchingCall(input, state);
    if (!raced) {
      throw new ReferenceIndexOrchestratorError(
        "invalid_run_state",
        "provider call reservation replay was not visible in durable state",
        false,
      );
    }
    return recoverCall(input, raced);
  }

  let invocation: ReferenceIndexProviderInvocationV1<T>;
  try {
    // Deliberately one invocation. Database retries happen only after this returns.
    invocation = await input.invokeOnce();
  } catch (error) {
    const failure = input.classifyFailure(error);
    try {
      await recordReferenceProviderFailure(input.rpc, {
        runId: input.runId,
        requestedBy: input.requestedBy,
        attemptNumber: input.attemptNumber,
        leaseToken: input.leaseToken,
        callId: prepared.callId,
        ...failure,
      });
    } catch (commitError) {
      throw new ReferenceIndexOrchestratorError(
        "provider_failure_commit_unknown",
        "provider failed but durable failure recording is unknown; provider HTTP replay is forbidden",
        true,
        commitError,
      );
    }
    throw error;
  }

  try {
    validateLedger(invocation.ledger);
  } catch (error) {
    try {
      await recordReferenceProviderFailure(input.rpc, {
        runId: input.runId,
        requestedBy: input.requestedBy,
        attemptNumber: input.attemptNumber,
        leaseToken: input.leaseToken,
        callId: prepared.callId,
        outcome: "failed",
        errorCode: "provider_result_invalid",
        errorDetail: String(error instanceof Error ? error.message : error)
          .slice(0, 1_000),
        providerRequestId: invocation.ledger.providerRequestId ?? null,
      });
    } catch (commitError) {
      throw new ReferenceIndexOrchestratorError(
        "provider_failure_commit_unknown",
        "provider result was invalid but durable failure recording is unknown; provider HTTP replay is forbidden",
        true,
        commitError,
      );
    }
    throw error;
  }
  try {
    const staged = await recordReferenceProviderResultDurably(input.rpc, {
      runId: input.runId,
      requestedBy: input.requestedBy,
      attemptNumber: input.attemptNumber,
      leaseToken: input.leaseToken,
      callId: prepared.callId,
      result: invocation.ledger,
    });
    return {
      value: invocation.value,
      callId: prepared.callId,
      replayed: staged.replayed,
      responseHash: staged.responseHash,
    };
  } catch (error) {
    throw new ReferenceIndexOrchestratorError(
      "provider_result_commit_unknown",
      "provider returned a result but its durable commit is unknown; provider HTTP replay is forbidden",
      true,
      error,
    );
  }
}
