// Pure scene candidate-delivery policy. All I/O is supplied through ports so the
// policy can be tested without credentials, Storage, provider calls, or RPCs.

export const SCENE_ANTI_COPY_REJECTION_THRESHOLD = 0.95;
export const SCENE_MAX_PROVIDER_CALLS = 2 as const;

export type SceneCandidateIndex = 0 | 1;
export type SceneProviderFunding = "user_reserved" | "system_anti_copy";
export type SceneCreditDisposition = "consume" | "release";

export interface SceneFixedConditioning {
  // Order is meaningful. Candidate 1 must preserve these arrays byte-for-byte.
  identityHashes: readonly string[];
  manualReferenceHashes: readonly string[];
  realismReferenceHashes: readonly string[];
  environmentReferenceHashes: readonly string[];
}

export interface SceneCandidateSnapshot {
  // The retrieval snapshot rotates on candidate 1. The fixed-reference
  // snapshot is immutable across both candidates and excludes identity.
  snapshotId: string;
  fixedReferenceSnapshotId: string;
  fixedReferenceManifestHash: string;
  fixedConditioning: SceneFixedConditioning;
  // Retrieved aesthetics are the only conditioning inputs allowed to rotate on
  // the system-funded anti-copy reroll.
  retrievedAestheticHashes: readonly string[];
}

export interface SceneProviderCallReservation {
  reservationId: string;
}

export interface SceneProviderCandidate {
  candidateId: string;
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  contentSha256: string;
}

export interface SceneAntiCopyEvaluation {
  evaluatorVersion: string;
  outputEmbeddingDigest: string;
  maxSimilarity: number;
  matchedReferenceKind:
    | "retrieved_style"
    | "user_inspiration"
    | "realism"
    | "environment";
  closestConditioningHash?: string | null;
}

export interface SceneUploadAuthorization {
  authorizationId: string;
}

export interface SceneUploadReceipt {
  uploadId: string;
}

export interface SceneDurableDelivery {
  deliveryRecordId: string;
  // The durable delivery adapter must atomically persist the accepted output
  // and consume the user's existing reservation. It must never mint units.
  userCreditConsumed: true;
}

export type SceneProviderCallOutcome =
  | "accepted"
  | "rejected_anti_copy"
  | "provider_error"
  | "candidate_invalid"
  | "evaluation_error";

export interface SceneDeliveryPorts {
  snapshotCandidateContext(input: {
    deliveryId: string;
    candidateIndex: SceneCandidateIndex;
    excludeRetrievedAestheticHashes: readonly string[];
  }): Promise<SceneCandidateSnapshot>;

  reserveProviderCall(input: {
    deliveryId: string;
    candidateIndex: SceneCandidateIndex;
    funding: SceneProviderFunding;
    snapshot: SceneCandidateSnapshot;
  }): Promise<SceneProviderCallReservation>;

  generateCandidate(input: {
    deliveryId: string;
    candidateIndex: SceneCandidateIndex;
    funding: SceneProviderFunding;
    snapshot: SceneCandidateSnapshot;
    reservation: SceneProviderCallReservation;
  }): Promise<SceneProviderCandidate>;

  evaluateAntiCopy(input: {
    deliveryId: string;
    candidateIndex: SceneCandidateIndex;
    snapshot: SceneCandidateSnapshot;
    reservation: SceneProviderCallReservation;
    candidate: SceneProviderCandidate;
  }): Promise<SceneAntiCopyEvaluation>;

  // This port deliberately receives candidate metadata, never candidate bytes.
  recordProviderCallResult(input: {
    deliveryId: string;
    candidateIndex: SceneCandidateIndex;
    funding: SceneProviderFunding;
    snapshotId: string;
    reservationId: string;
    outcome: SceneProviderCallOutcome;
    candidateId: string | null;
    candidateContentSha256: string | null;
    evaluation: SceneAntiCopyEvaluation | null;
    errorCode: string | null;
  }): Promise<{
    decision: "accepted" | "copy_rejected";
    rerollAllowed: boolean;
  } | null>;

  authorizeAcceptedUpload(input: {
    deliveryId: string;
    candidateIndex: SceneCandidateIndex;
    snapshot: SceneCandidateSnapshot;
    reservation: SceneProviderCallReservation;
    candidateId: string;
    candidateContentSha256: string;
    evaluation: SceneAntiCopyEvaluation;
  }): Promise<SceneUploadAuthorization>;

  uploadAcceptedCandidate(input: {
    deliveryId: string;
    candidateIndex: SceneCandidateIndex;
    authorization: SceneUploadAuthorization;
    candidate: SceneProviderCandidate;
  }): Promise<SceneUploadReceipt>;

  commitDurableDelivery(input: {
    deliveryId: string;
    candidateIndex: SceneCandidateIndex;
    snapshot: SceneCandidateSnapshot;
    reservation: SceneProviderCallReservation;
    candidate: SceneProviderCandidate;
    evaluation: SceneAntiCopyEvaluation;
    authorization: SceneUploadAuthorization;
    upload: SceneUploadReceipt;
  }): Promise<SceneDurableDelivery>;

  // Once accepted bytes reach their deterministic Storage path, an uncertain
  // database commit must be recovered in place. Deleting it could trigger a
  // duplicate paid provider call on retry.
  markAcceptedUploadRecoverable(input: {
    deliveryId: string;
    candidateIndex: SceneCandidateIndex;
    authorization: SceneUploadAuthorization;
    upload: SceneUploadReceipt;
  }): Promise<void>;

  // Implementations must make this idempotent on deliveryId. `consume` verifies
  // the atomic durable-delivery settlement above; `release` terminalizes a job
  // that produced no accepted Storage object.
  settleUserCredit(input: {
    deliveryId: string;
    disposition: SceneCreditDisposition;
  }): Promise<void>;
}

export type SceneDeliveryResult =
  | {
    delivered: true;
    status: 200;
    candidateIndex: SceneCandidateIndex;
    providerCalls: 1 | 2;
    userCreditDisposition: "consume";
    snapshot: SceneCandidateSnapshot;
    evaluation: SceneAntiCopyEvaluation;
    durableDelivery: SceneDurableDelivery;
  }
  | {
    delivered: false;
    status: 422;
    error: "scene_candidates_rejected_anti_copy";
    providerCalls: 2;
    userCreditDisposition: "release";
  };

export class SceneDeliveryOrchestratorError extends Error {
  readonly code: string;
  readonly status: number;
  readonly causeValue: unknown;

  constructor(code: string, status: number, causeValue?: unknown) {
    super(code);
    this.name = "SceneDeliveryOrchestratorError";
    this.code = code;
    this.status = status;
    this.causeValue = causeValue;
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function requireNonEmptyString(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new SceneDeliveryOrchestratorError(`${name}_invalid`, 500);
  }
}

function validateHashes(values: readonly string[], name: string, requireOne = false): void {
  if (!Array.isArray(values) || (requireOne && values.length === 0)) {
    throw new SceneDeliveryOrchestratorError(`${name}_invalid`, 500);
  }
  const unique = new Set<string>();
  for (const value of values) {
    if (!SHA256_RE.test(value) || unique.has(value)) {
      throw new SceneDeliveryOrchestratorError(`${name}_invalid`, 500);
    }
    unique.add(value);
  }
}

function validateSnapshot(snapshot: SceneCandidateSnapshot): void {
  requireNonEmptyString(snapshot.snapshotId, "scene_snapshot_id");
  requireNonEmptyString(
    snapshot.fixedReferenceSnapshotId,
    "scene_fixed_reference_snapshot_id",
  );
  if (!SHA256_RE.test(snapshot.fixedReferenceManifestHash)) {
    throw new SceneDeliveryOrchestratorError(
      "scene_fixed_reference_manifest_hash_invalid",
      500,
    );
  }
  validateHashes(snapshot.fixedConditioning.identityHashes, "scene_identity_hashes");
  validateHashes(snapshot.fixedConditioning.manualReferenceHashes, "scene_manual_reference_hashes");
  validateHashes(snapshot.fixedConditioning.realismReferenceHashes, "scene_realism_reference_hashes");
  validateHashes(snapshot.fixedConditioning.environmentReferenceHashes, "scene_environment_reference_hashes");
  validateHashes(snapshot.retrievedAestheticHashes, "scene_retrieved_aesthetic_hashes", true);
  if (snapshot.retrievedAestheticHashes.length !== 3) {
    throw new SceneDeliveryOrchestratorError(
      "scene_retrieved_aesthetic_reference_count_invalid",
      500,
    );
  }
  validateHashes([
    ...snapshot.retrievedAestheticHashes,
    ...snapshot.fixedConditioning.manualReferenceHashes,
    ...snapshot.fixedConditioning.realismReferenceHashes,
    ...snapshot.fixedConditioning.environmentReferenceHashes,
    ...snapshot.fixedConditioning.identityHashes,
  ], "scene_all_conditioning_hashes", true);
}

function immutableSnapshot(snapshot: SceneCandidateSnapshot): SceneCandidateSnapshot {
  validateSnapshot(snapshot);
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    fixedReferenceSnapshotId: snapshot.fixedReferenceSnapshotId,
    fixedReferenceManifestHash: snapshot.fixedReferenceManifestHash,
    fixedConditioning: Object.freeze({
      identityHashes: Object.freeze([...snapshot.fixedConditioning.identityHashes]),
      manualReferenceHashes: Object.freeze([...snapshot.fixedConditioning.manualReferenceHashes]),
      realismReferenceHashes: Object.freeze([...snapshot.fixedConditioning.realismReferenceHashes]),
      environmentReferenceHashes: Object.freeze([...snapshot.fixedConditioning.environmentReferenceHashes]),
    }),
    retrievedAestheticHashes: Object.freeze([...snapshot.retrievedAestheticHashes]),
  });
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertFixedConditioningPreserved(
  first: SceneCandidateSnapshot,
  second: SceneCandidateSnapshot,
): void {
  const preserved =
    first.fixedReferenceSnapshotId === second.fixedReferenceSnapshotId
    && first.fixedReferenceManifestHash === second.fixedReferenceManifestHash
    && arraysEqual(first.fixedConditioning.identityHashes, second.fixedConditioning.identityHashes)
    && arraysEqual(first.fixedConditioning.manualReferenceHashes, second.fixedConditioning.manualReferenceHashes)
    && arraysEqual(first.fixedConditioning.realismReferenceHashes, second.fixedConditioning.realismReferenceHashes)
    && arraysEqual(first.fixedConditioning.environmentReferenceHashes, second.fixedConditioning.environmentReferenceHashes);
  if (!preserved) {
    throw new SceneDeliveryOrchestratorError("scene_fixed_conditioning_changed_on_reroll", 500);
  }
}

function assertRetrievedAestheticsRotated(
  first: SceneCandidateSnapshot,
  second: SceneCandidateSnapshot,
): void {
  if (first.snapshotId === second.snapshotId) {
    throw new SceneDeliveryOrchestratorError("scene_reroll_snapshot_reused", 500);
  }
  if (first.retrievedAestheticHashes.length !== second.retrievedAestheticHashes.length) {
    throw new SceneDeliveryOrchestratorError("scene_reroll_reference_count_changed", 500);
  }
  const excluded = new Set(first.retrievedAestheticHashes);
  if (second.retrievedAestheticHashes.some((hash) => excluded.has(hash))) {
    throw new SceneDeliveryOrchestratorError("scene_reroll_reference_reused", 500);
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function validateCandidate(candidate: SceneProviderCandidate): Promise<void> {
  requireNonEmptyString(candidate.candidateId, "scene_candidate_id");
  if (!["image/jpeg", "image/png", "image/webp"].includes(candidate.mimeType)) {
    throw new SceneDeliveryOrchestratorError("scene_candidate_mime_type_invalid", 502);
  }
  if (!(candidate.bytes instanceof Uint8Array) || candidate.bytes.byteLength === 0) {
    throw new SceneDeliveryOrchestratorError("scene_candidate_bytes_invalid", 502);
  }
  if (!Number.isSafeInteger(candidate.width) || candidate.width <= 0
    || !Number.isSafeInteger(candidate.height) || candidate.height <= 0) {
    throw new SceneDeliveryOrchestratorError("scene_candidate_dimensions_invalid", 502);
  }
  if (!SHA256_RE.test(candidate.contentSha256)) {
    throw new SceneDeliveryOrchestratorError("scene_candidate_hash_invalid", 502);
  }
  if (await digestBytes(candidate.bytes) !== candidate.contentSha256) {
    throw new SceneDeliveryOrchestratorError("scene_candidate_hash_mismatch", 502);
  }
}

function validateEvaluation(evaluation: SceneAntiCopyEvaluation): void {
  requireNonEmptyString(evaluation.evaluatorVersion, "scene_anti_copy_evaluator_version");
  if (!SHA256_RE.test(evaluation.outputEmbeddingDigest)) {
    throw new SceneDeliveryOrchestratorError("scene_anti_copy_embedding_digest_invalid", 502);
  }
  if (!["retrieved_style", "user_inspiration", "realism", "environment"]
    .includes(evaluation.matchedReferenceKind)) {
    throw new SceneDeliveryOrchestratorError("scene_anti_copy_reference_kind_invalid", 502);
  }
  if (!Number.isFinite(evaluation.maxSimilarity)
    || evaluation.maxSimilarity < -1
    || evaluation.maxSimilarity > 1) {
    throw new SceneDeliveryOrchestratorError("scene_anti_copy_score_invalid", 502);
  }
  if (evaluation.closestConditioningHash != null
    && !SHA256_RE.test(evaluation.closestConditioningHash)) {
    throw new SceneDeliveryOrchestratorError("scene_anti_copy_match_hash_invalid", 502);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof SceneDeliveryOrchestratorError) return error.code;
  if (error instanceof Error && error.message) return error.message.slice(0, 120);
  return "scene_delivery_failed";
}

function zeroCandidateBytes(candidate: SceneProviderCandidate | null): void {
  candidate?.bytes.fill(0);
}

/**
 * Runs one user delivery attempt plus, only after an anti-copy rejection, one
 * system-funded reroll. Provider-call and credit ports must be idempotent on the
 * supplied delivery/reservation identifiers so process-level retries reconcile.
 */
export async function deliverSceneWithAntiCopyReroll(
  deliveryId: string,
  ports: SceneDeliveryPorts,
): Promise<SceneDeliveryResult> {
  requireNonEmptyString(deliveryId, "scene_delivery_id");

  let firstSnapshot: SceneCandidateSnapshot | null = null;
  let firstReservationId: string | null = null;
  let providerCalls = 0;
  let activeCandidate: SceneProviderCandidate | null = null;
  let uploaded: {
    candidateIndex: SceneCandidateIndex;
    authorization: SceneUploadAuthorization;
    receipt: SceneUploadReceipt;
  } | null = null;
  let durableCommitted = false;
  let creditDisposition: SceneCreditDisposition | null = null;

  const settleCreditOnce = async (disposition: SceneCreditDisposition): Promise<void> => {
    if (creditDisposition !== null) {
      if (creditDisposition !== disposition) {
        throw new SceneDeliveryOrchestratorError("scene_credit_disposition_conflict", 500);
      }
      return;
    }
    await ports.settleUserCredit({ deliveryId, disposition });
    creditDisposition = disposition;
  };

  try {
    for (const candidateIndex of [0, 1] as const) {
      const funding: SceneProviderFunding = candidateIndex === 0
        ? "user_reserved"
        : "system_anti_copy";
      const excludedHashes = firstSnapshot?.retrievedAestheticHashes ?? [];
      const snapshot = immutableSnapshot(await ports.snapshotCandidateContext({
        deliveryId,
        candidateIndex,
        excludeRetrievedAestheticHashes: excludedHashes,
      }));

      if (candidateIndex === 0) {
        firstSnapshot = snapshot;
      } else {
        if (!firstSnapshot) {
          throw new SceneDeliveryOrchestratorError("scene_primary_snapshot_missing", 500);
        }
        assertFixedConditioningPreserved(firstSnapshot, snapshot);
        assertRetrievedAestheticsRotated(firstSnapshot, snapshot);
      }

      const reservation = await ports.reserveProviderCall({
        deliveryId,
        candidateIndex,
        funding,
        snapshot,
      });
      requireNonEmptyString(reservation.reservationId, "scene_provider_reservation_id");
      if (candidateIndex === 0) {
        firstReservationId = reservation.reservationId;
      } else if (reservation.reservationId === firstReservationId) {
        throw new SceneDeliveryOrchestratorError("scene_provider_reservation_reused", 500);
      }

      if (providerCalls >= SCENE_MAX_PROVIDER_CALLS) {
        throw new SceneDeliveryOrchestratorError("scene_provider_call_limit_exceeded", 500);
      }
      providerCalls += 1;

      try {
        activeCandidate = await ports.generateCandidate({
          deliveryId,
          candidateIndex,
          funding,
          snapshot,
          reservation,
        });
      } catch (error) {
        await ports.recordProviderCallResult({
          deliveryId,
          candidateIndex,
          funding,
          snapshotId: snapshot.snapshotId,
          reservationId: reservation.reservationId,
          outcome: "provider_error",
          candidateId: null,
          candidateContentSha256: null,
          evaluation: null,
          errorCode: errorCode(error),
        });
        throw error;
      }

      try {
        await validateCandidate(activeCandidate);
      } catch (error) {
        await ports.recordProviderCallResult({
          deliveryId,
          candidateIndex,
          funding,
          snapshotId: snapshot.snapshotId,
          reservationId: reservation.reservationId,
          outcome: "candidate_invalid",
          candidateId: activeCandidate?.candidateId ?? null,
          candidateContentSha256: activeCandidate?.contentSha256 ?? null,
          evaluation: null,
          errorCode: errorCode(error),
        });
        throw error;
      }

      let evaluation: SceneAntiCopyEvaluation;
      try {
        evaluation = await ports.evaluateAntiCopy({
          deliveryId,
          candidateIndex,
          snapshot,
          reservation,
          candidate: activeCandidate,
        });
        validateEvaluation(evaluation);
      } catch (error) {
        await ports.recordProviderCallResult({
          deliveryId,
          candidateIndex,
          funding,
          snapshotId: snapshot.snapshotId,
          reservationId: reservation.reservationId,
          outcome: "evaluation_error",
          candidateId: activeCandidate.candidateId,
          candidateContentSha256: activeCandidate.contentSha256,
          evaluation: null,
          errorCode: errorCode(error),
        });
        throw error;
      }

      // Strictly greater than 0.95 is rejected. Exactly 0.95 is accepted.
      const rejected = evaluation.maxSimilarity > SCENE_ANTI_COPY_REJECTION_THRESHOLD;
      const recorded = await ports.recordProviderCallResult({
        deliveryId,
        candidateIndex,
        funding,
        snapshotId: snapshot.snapshotId,
        reservationId: reservation.reservationId,
        outcome: rejected ? "rejected_anti_copy" : "accepted",
        candidateId: activeCandidate.candidateId,
        candidateContentSha256: activeCandidate.contentSha256,
        evaluation,
        errorCode: null,
      });
      const expectedDecision = rejected ? "copy_rejected" : "accepted";
      if (!recorded || recorded.decision !== expectedDecision) {
        throw new SceneDeliveryOrchestratorError(
          "scene_anti_copy_decision_record_mismatch",
          500,
        );
      }

      if (rejected) {
        // No authorization or upload port ever sees rejected candidate bytes.
        zeroCandidateBytes(activeCandidate);
        activeCandidate = null;
        if (candidateIndex === 0) {
          if (!recorded.rerollAllowed) {
            throw new SceneDeliveryOrchestratorError(
              "scene_anti_copy_reroll_not_authorized",
              500,
            );
          }
          continue;
        }

        await settleCreditOnce("release");
        return {
          delivered: false,
          status: 422,
          error: "scene_candidates_rejected_anti_copy",
          providerCalls: 2,
          userCreditDisposition: "release",
        };
      }

      // Acceptance is durable before an upload capability is minted.
      const authorization = await ports.authorizeAcceptedUpload({
        deliveryId,
        candidateIndex,
        snapshot,
        reservation,
        candidateId: activeCandidate.candidateId,
        candidateContentSha256: activeCandidate.contentSha256,
        evaluation,
      });
      requireNonEmptyString(authorization.authorizationId, "scene_upload_authorization_id");

      const receipt = await ports.uploadAcceptedCandidate({
        deliveryId,
        candidateIndex,
        authorization,
        candidate: activeCandidate,
      });
      requireNonEmptyString(receipt.uploadId, "scene_upload_id");
      uploaded = { candidateIndex, authorization, receipt };

      const durableDelivery = await ports.commitDurableDelivery({
        deliveryId,
        candidateIndex,
        snapshot,
        reservation,
        candidate: activeCandidate,
        evaluation,
        authorization,
        upload: receipt,
      });
      requireNonEmptyString(durableDelivery.deliveryRecordId, "scene_durable_delivery_id");
      if (durableDelivery.userCreditConsumed !== true) {
        throw new SceneDeliveryOrchestratorError(
          "scene_durable_delivery_credit_not_consumed",
          500,
        );
      }
      durableCommitted = true;
      uploaded = null;

      // User credit is consumed exactly once and only beyond the durable-delivery
      // boundary. A failure here is reconciliation-required and never releases.
      await settleCreditOnce("consume");
      zeroCandidateBytes(activeCandidate);
      activeCandidate = null;

      return {
        delivered: true,
        status: 200,
        candidateIndex,
        providerCalls: providerCalls as 1 | 2,
        userCreditDisposition: "consume",
        snapshot,
        evaluation,
        durableDelivery,
      };
    }

    throw new SceneDeliveryOrchestratorError("scene_candidate_loop_exhausted", 500);
  } catch (error) {
    zeroCandidateBytes(activeCandidate);
    activeCandidate = null;

    let recoveryError: unknown = null;
    if (uploaded && !durableCommitted) {
      try {
        await ports.markAcceptedUploadRecoverable({
          deliveryId,
          candidateIndex: uploaded.candidateIndex,
          authorization: uploaded.authorization,
          upload: uploaded.receipt,
        });
      } catch (recoveryFailure) {
        recoveryError = recoveryFailure;
      }
      throw new SceneDeliveryOrchestratorError(
        "scene_delivery_reconciliation_required",
        202,
        { originalError: error, recoveryError },
      );
    }

    // Recovery/indeterminate ports deliberately preserve the existing job and
    // reservation so a status replay can reconcile without another paid call.
    if (error instanceof SceneDeliveryOrchestratorError
      && error.status === 202) {
      throw error;
    }

    if (!durableCommitted) {
      try {
        await settleCreditOnce("release");
      } catch (creditError) {
        throw new SceneDeliveryOrchestratorError(
          "scene_credit_release_reconciliation_required",
          503,
          { originalError: error, creditError },
        );
      }
    }

    if (durableCommitted && creditDisposition !== "consume") {
      throw new SceneDeliveryOrchestratorError(
        "scene_credit_consume_reconciliation_required",
        503,
        error,
      );
    }
    if (error instanceof SceneDeliveryOrchestratorError) throw error;
    throw new SceneDeliveryOrchestratorError("scene_delivery_failed", 502, error);
  }
}
