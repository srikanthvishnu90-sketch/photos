import {
  SCENE_ANTI_COPY_REJECTION_THRESHOLD,
  SceneDeliveryOrchestratorError,
  deliverSceneWithAntiCopyReroll,
  type SceneCandidateSnapshot,
  type SceneCreditDisposition,
  type SceneDeliveryPorts,
  type SceneProviderCandidate,
} from "./scene-delivery-orchestrator-v1.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = "values differ"): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, received ${actualJson}`);
  }
}

async function assertRejectsWithCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof SceneDeliveryOrchestratorError, "expected orchestrator error");
    assertEquals(error.code, code, "unexpected orchestrator error code");
    return;
  }
  throw new Error(`expected rejection with ${code}`);
}

const H = {
  identity: "1".repeat(64),
  manual: "2".repeat(64),
  environment: "3".repeat(64),
  realism: "c".repeat(64),
  aesthetic0a: "4".repeat(64),
  aesthetic0b: "5".repeat(64),
  aesthetic0c: "6".repeat(64),
  aesthetic1a: "7".repeat(64),
  aesthetic1b: "8".repeat(64),
  aesthetic1c: "9".repeat(64),
  candidate0: "a".repeat(64),
  candidate1: "b".repeat(64),
};

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function snapshot(index: 0 | 1, retrievedAestheticHashes: readonly string[]): SceneCandidateSnapshot {
  return {
    snapshotId: `snapshot-${index}`,
    fixedReferenceSnapshotId: "fixed-snapshot",
    fixedReferenceManifestHash: "d".repeat(64),
    fixedConditioning: {
      identityHashes: [H.identity],
      manualReferenceHashes: [H.manual],
      realismReferenceHashes: [H.realism],
      environmentReferenceHashes: [H.environment],
    },
    retrievedAestheticHashes,
  };
}

interface HarnessOptions {
  scores: readonly number[];
  snapshots?: readonly [SceneCandidateSnapshot, SceneCandidateSnapshot];
  failDurableCommit?: boolean;
  failCreditConsume?: boolean;
  corruptCandidateHash?: boolean;
}

function harness(options: HarnessOptions): {
  ports: SceneDeliveryPorts;
  events: string[];
  candidates: SceneProviderCandidate[];
  authorizedCandidates: number[];
  uploadedCandidates: number[];
  uploadedByteCopies: number[][];
  excludedByCandidate: string[][];
  creditDispositions: SceneCreditDisposition[];
} {
  const events: string[] = [];
  const candidates: SceneProviderCandidate[] = [];
  const authorizedCandidates: number[] = [];
  const uploadedCandidates: number[] = [];
  const uploadedByteCopies: number[][] = [];
  const excludedByCandidate: string[][] = [];
  const creditDispositions: SceneCreditDisposition[] = [];
  const snapshots = options.snapshots ?? [
    snapshot(0, [H.aesthetic0a, H.aesthetic0b, H.aesthetic0c]),
    snapshot(1, [H.aesthetic1a, H.aesthetic1b, H.aesthetic1c]),
  ];

  const ports: SceneDeliveryPorts = {
    async snapshotCandidateContext(input) {
      events.push(`snapshot:${input.candidateIndex}`);
      excludedByCandidate[input.candidateIndex] = [...input.excludeRetrievedAestheticHashes];
      return snapshots[input.candidateIndex];
    },

    async reserveProviderCall(input) {
      events.push(`reserve:${input.candidateIndex}:${input.funding}`);
      return { reservationId: `reservation-${input.candidateIndex}` };
    },

    async generateCandidate(input) {
      events.push(`provider:${input.candidateIndex}`);
      const candidate: SceneProviderCandidate = {
        candidateId: `candidate-${input.candidateIndex}`,
        bytes: new Uint8Array([input.candidateIndex + 1, 22, 33]),
        mimeType: "image/png",
        width: 1,
        height: 3,
        contentSha256: "",
      };
      candidate.contentSha256 = await hashBytes(candidate.bytes);
      if (options.corruptCandidateHash) {
        candidate.contentSha256 = H.candidate0;
      }
      candidates[input.candidateIndex] = candidate;
      return candidate;
    },

    async evaluateAntiCopy(input) {
      events.push(`evaluate:${input.candidateIndex}`);
      return {
        evaluatorVersion: "anti-copy-test-v1",
        outputEmbeddingDigest: H.candidate0,
        maxSimilarity: options.scores[input.candidateIndex],
        matchedReferenceKind: "retrieved_style",
        closestConditioningHash: input.snapshot.retrievedAestheticHashes[0],
      };
    },

    async recordProviderCallResult(input) {
      events.push(`result:${input.candidateIndex}:${input.outcome}`);
      assert(!("bytes" in input), "provider result port must not receive candidate bytes");
      if (input.outcome === "accepted") return { decision: "accepted", rerollAllowed: false };
      if (input.outcome === "rejected_anti_copy") {
        return { decision: "copy_rejected", rerollAllowed: input.candidateIndex === 0 };
      }
      return null;
    },

    async authorizeAcceptedUpload(input) {
      events.push(`authorize:${input.candidateIndex}`);
      authorizedCandidates.push(input.candidateIndex);
      assert(
        input.evaluation.maxSimilarity <= SCENE_ANTI_COPY_REJECTION_THRESHOLD,
        "upload was authorized before anti-copy acceptance",
      );
      return { authorizationId: `authorization-${input.candidateIndex}` };
    },

    async uploadAcceptedCandidate(input) {
      events.push(`upload:${input.candidateIndex}`);
      uploadedCandidates.push(input.candidateIndex);
      uploadedByteCopies.push(Array.from(input.candidate.bytes));
      return { uploadId: `upload-${input.candidateIndex}` };
    },

    async commitDurableDelivery(input) {
      events.push(`durable:${input.candidateIndex}`);
      if (options.failDurableCommit) throw new Error("durable_commit_failed");
      return { deliveryRecordId: `durable-${input.candidateIndex}`, userCreditConsumed: true };
    },

    async markAcceptedUploadRecoverable(input) {
      events.push(`recover:${input.candidateIndex}`);
    },

    async settleUserCredit(input) {
      events.push(`credit:${input.disposition}`);
      creditDispositions.push(input.disposition);
      if (input.disposition === "consume" && options.failCreditConsume) {
        throw new Error("credit_consume_failed");
      }
    },
  };

  return {
    ports,
    events,
    candidates,
    authorizedCandidates,
    uploadedCandidates,
    uploadedByteCopies,
    excludedByCandidate,
    creditDispositions,
  };
}

Deno.test("strict threshold accepts candidate 0 at exactly 0.95 and charges after durable delivery", async () => {
  const test = harness({ scores: [0.95, 1] });
  const result = await deliverSceneWithAntiCopyReroll("delivery-threshold", test.ports);

  assert(result.delivered);
  assertEquals(result.candidateIndex, 0);
  assertEquals(result.providerCalls, 1);
  assertEquals(test.authorizedCandidates, [0]);
  assertEquals(test.uploadedCandidates, [0]);
  assertEquals(test.uploadedByteCopies, [[1, 22, 33]]);
  assertEquals(test.creditDispositions, ["consume"]);
  assert(
    test.events.indexOf("durable:0") < test.events.indexOf("credit:consume"),
    "credit must be consumed only after durable delivery",
  );
  assertEquals(Array.from(test.candidates[0].bytes), [0, 0, 0], "delivered bytes should be cleared after use");
});

Deno.test("candidate 0 rejection rerolls once with disjoint aesthetics and system funding", async () => {
  const test = harness({ scores: [0.950001, 0.8] });
  const result = await deliverSceneWithAntiCopyReroll("delivery-reroll", test.ports);

  assert(result.delivered);
  assertEquals(result.candidateIndex, 1);
  assertEquals(result.providerCalls, 2);
  assertEquals(test.excludedByCandidate[1], [
    H.aesthetic0a,
    H.aesthetic0b,
    H.aesthetic0c,
  ]);
  assert(test.events.includes("reserve:1:system_anti_copy"));
  assertEquals(test.authorizedCandidates, [1], "rejected candidate must never be authorized");
  assertEquals(test.uploadedCandidates, [1], "rejected candidate must never be uploaded");
  assertEquals(test.uploadedByteCopies, [[2, 22, 33]], "only accepted bytes may cross the upload port");
  assertEquals(test.creditDispositions, ["consume"], "the user is charged once for delivered output");
  assertEquals(Array.from(test.candidates[0].bytes), [0, 0, 0], "rejected bytes must be cleared");
  assertEquals(Array.from(test.candidates[1].bytes), [0, 0, 0], "delivered bytes should be cleared after use");
});

Deno.test("two strict anti-copy rejections return 422, release credit, and upload zero bytes", async () => {
  const test = harness({ scores: [0.96, 0.951] });
  const result = await deliverSceneWithAntiCopyReroll("delivery-rejected", test.ports);

  assert(!result.delivered);
  assertEquals(result.status, 422);
  assertEquals(result.providerCalls, 2);
  assertEquals(result.error, "scene_candidates_rejected_anti_copy");
  assertEquals(test.authorizedCandidates, []);
  assertEquals(test.uploadedCandidates, []);
  assertEquals(test.uploadedByteCopies, []);
  assertEquals(test.creditDispositions, ["release"]);
  assertEquals(Array.from(test.candidates[0].bytes), [0, 0, 0]);
  assertEquals(Array.from(test.candidates[1].bytes), [0, 0, 0]);
  assertEquals(test.events.filter((event) => event.startsWith("provider:")).length, 2);
});

Deno.test("reroll fails closed before provider call when a retrieved aesthetic hash is reused", async () => {
  const overlappingSnapshots: [SceneCandidateSnapshot, SceneCandidateSnapshot] = [
    snapshot(0, [H.aesthetic0a, H.aesthetic0b, H.aesthetic0c]),
    snapshot(1, [H.aesthetic0b, H.aesthetic1a, H.aesthetic1b]),
  ];
  const test = harness({ scores: [0.99, 0], snapshots: overlappingSnapshots });

  await assertRejectsWithCode(
    () => deliverSceneWithAntiCopyReroll("delivery-overlap", test.ports),
    "scene_reroll_reference_reused",
  );
  assertEquals(test.events.filter((event) => event.startsWith("provider:")).length, 1);
  assertEquals(test.authorizedCandidates, []);
  assertEquals(test.uploadedCandidates, []);
  assertEquals(test.creditDispositions, ["release"]);
});

Deno.test("candidate bytes must match the recorded SHA-256 before evaluation or upload", async () => {
  const test = harness({ scores: [0.1, 0.1], corruptCandidateHash: true });

  await assertRejectsWithCode(
    () => deliverSceneWithAntiCopyReroll("delivery-hash-mismatch", test.ports),
    "scene_candidate_hash_mismatch",
  );
  assert(test.events.includes("result:0:candidate_invalid"));
  assert(!test.events.some((event) => event.startsWith("evaluate:")));
  assertEquals(test.authorizedCandidates, []);
  assertEquals(test.uploadedCandidates, []);
  assertEquals(test.creditDispositions, ["release"]);
  assertEquals(Array.from(test.candidates[0].bytes), [0, 0, 0]);
});

Deno.test("snapshot fails closed unless it contains exactly three retrieved references", async () => {
  const invalidSnapshots: [SceneCandidateSnapshot, SceneCandidateSnapshot] = [
    snapshot(0, [H.aesthetic0a, H.aesthetic0b]),
    snapshot(1, [H.aesthetic1a, H.aesthetic1b, H.aesthetic1c]),
  ];
  const test = harness({ scores: [0.1, 0.1], snapshots: invalidSnapshots });

  await assertRejectsWithCode(
    () => deliverSceneWithAntiCopyReroll("delivery-reference-count", test.ports),
    "scene_retrieved_aesthetic_reference_count_invalid",
  );
  assertEquals(test.events.filter((event) => event.startsWith("provider:")).length, 0);
  assertEquals(test.uploadedCandidates, []);
  assertEquals(test.creditDispositions, ["release"]);
});

Deno.test("failed durable commit preserves accepted upload for recovery without settling credit", async () => {
  const test = harness({ scores: [0.2, 1], failDurableCommit: true });

  await assertRejectsWithCode(
    () => deliverSceneWithAntiCopyReroll("delivery-durable-failure", test.ports),
    "scene_delivery_reconciliation_required",
  );
  assertEquals(test.uploadedCandidates, [0]);
  assert(test.events.includes("recover:0"));
  assertEquals(test.creditDispositions, []);
  assert(!test.events.includes("credit:consume"));
});

Deno.test("credit failure after durable delivery never releases delivered output", async () => {
  const test = harness({ scores: [0.2, 1], failCreditConsume: true });

  await assertRejectsWithCode(
    () => deliverSceneWithAntiCopyReroll("delivery-credit-failure", test.ports),
    "scene_credit_consume_reconciliation_required",
  );
  assert(test.events.includes("durable:0"));
  assertEquals(test.creditDispositions, ["consume"]);
  assert(!test.events.includes("credit:release"));
  assert(!test.events.includes("recover:0"));
});
