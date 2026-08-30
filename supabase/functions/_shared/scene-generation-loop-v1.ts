import type { RetrievedConditioningReference } from "./reference-retriever-v1.ts";
import type {
  AntiCopyDecision,
  ConditioningReferenceKind,
} from "./scene-anti-copy-v1.ts";

export interface PreparedSceneCandidate {
  candidateIndex: 0 | 1;
  providerCallId: string;
  invokeAllowed: boolean;
  existingStatus: string;
  fundingSource: "user_reserved" | "system_anti_copy";
  referenceManifestHash: string;
  references: readonly RetrievedConditioningReference[];
  providerRequestBody: string;
}

export interface GeneratedSceneCandidate {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  contentSha256: string;
  providerRequestId: string | null;
  providerResponseId: string | null;
  inputUnits: number;
  outputUnits: number;
  costMicros: number;
  providerMeta: Record<string, unknown>;
}

export interface EvaluatedCandidate {
  decision: AntiCopyDecision;
  outputEmbeddingDigest: string;
}

export interface AcceptedSceneCandidate extends GeneratedSceneCandidate {
  candidateIndex: 0 | 1;
  providerCallId: string;
  referenceManifestHash: string;
  antiCopyDecision: AntiCopyDecision;
  outputEmbeddingDigest: string;
  rerollUsed: boolean;
  initialRejection?: {
    providerCallId: string;
    maximumSimilarity: number;
    matchedReferenceKind: ConditioningReferenceKind;
    matchedReferenceSha256: string;
  };
}

export class SceneGenerationLoopError extends Error {
  constructor(
    readonly code:
      | "provider_call_replay_requires_recovery"
      | "anti_copy_evaluation_failed"
      | "anti_copy_reroll_not_authorized"
      | "anti_copy_reroll_rejected",
    message: string,
  ) {
    super(message);
    this.name = "SceneGenerationLoopError";
  }
}

export interface SceneGenerationLoopDependencies {
  prepareCandidate(input: {
    candidateIndex: 0 | 1;
    previousRejection?: AntiCopyDecision;
  }): Promise<PreparedSceneCandidate>;
  invokeProvider(candidate: PreparedSceneCandidate): Promise<GeneratedSceneCandidate>;
  evaluateCandidate(input: {
    candidate: GeneratedSceneCandidate;
    references: readonly RetrievedConditioningReference[];
  }): Promise<EvaluatedCandidate>;
  recordCandidate(input: {
    prepared: PreparedSceneCandidate;
    generated: GeneratedSceneCandidate;
    evaluated: EvaluatedCandidate;
  }): Promise<{ decision: "accepted" | "copy_rejected"; rerollAllowed: boolean }>;
}

function eraseRejectedCandidate(candidate: GeneratedSceneCandidate): void {
  candidate.bytes.fill(0);
}

/**
 * Runs one image-provider call and, only after an anti-copy rejection, one
 * system-funded reroll. Upload is intentionally absent: only the accepted
 * return value may cross the Storage boundary in the caller.
 */
export async function generateSceneWithAntiCopy(
  dependencies: SceneGenerationLoopDependencies,
): Promise<AcceptedSceneCandidate> {
  let initialRejection: AcceptedSceneCandidate["initialRejection"];
  let previousDecision: AntiCopyDecision | undefined;

  for (const candidateIndex of [0, 1] as const) {
    const prepared = await dependencies.prepareCandidate({
      candidateIndex,
      previousRejection: previousDecision,
    });
    if (!prepared.invokeAllowed) {
      throw new SceneGenerationLoopError(
        "provider_call_replay_requires_recovery",
        `candidate ${candidateIndex} already has status ${prepared.existingStatus}`,
      );
    }

    const generated = await dependencies.invokeProvider(prepared);
    let evaluated: EvaluatedCandidate;
    try {
      evaluated = await dependencies.evaluateCandidate({
        candidate: generated,
        references: prepared.references,
      });
    } catch (error) {
      eraseRejectedCandidate(generated);
      throw new SceneGenerationLoopError(
        "anti_copy_evaluation_failed",
        `candidate evaluation failed: ${String(error)}`,
      );
    }

    const recorded = await dependencies.recordCandidate({
      prepared,
      generated,
      evaluated,
    });
    const expectedDecision = evaluated.decision.rejected
      ? "copy_rejected"
      : "accepted";
    if (recorded.decision !== expectedDecision) {
      eraseRejectedCandidate(generated);
      throw new SceneGenerationLoopError(
        "anti_copy_evaluation_failed",
        "database and in-process anti-copy decisions differ",
      );
    }

    if (recorded.decision === "accepted") {
      return {
        ...generated,
        candidateIndex,
        providerCallId: prepared.providerCallId,
        referenceManifestHash: prepared.referenceManifestHash,
        antiCopyDecision: evaluated.decision,
        outputEmbeddingDigest: evaluated.outputEmbeddingDigest,
        rerollUsed: candidateIndex === 1,
        ...(initialRejection ? { initialRejection } : {}),
      };
    }

    eraseRejectedCandidate(generated);
    if (candidateIndex === 0) {
      if (!recorded.rerollAllowed) {
        throw new SceneGenerationLoopError(
          "anti_copy_reroll_not_authorized",
          "first anti-copy rejection did not authorize the reroll slot",
        );
      }
      initialRejection = {
        providerCallId: prepared.providerCallId,
        maximumSimilarity: evaluated.decision.maximumSimilarity,
        matchedReferenceKind: evaluated.decision.matchedReferenceKind,
        matchedReferenceSha256: evaluated.decision.matchedReferenceSha256,
      };
      previousDecision = evaluated.decision;
      continue;
    }

    throw new SceneGenerationLoopError(
      "anti_copy_reroll_rejected",
      "both generated candidates were too similar to a conditioning reference",
    );
  }

  throw new SceneGenerationLoopError(
    "anti_copy_reroll_rejected",
    "anti-copy loop exhausted without an accepted candidate",
  );
}
