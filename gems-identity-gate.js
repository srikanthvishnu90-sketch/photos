// gems-identity-gate.js — R22 of the Reference Protocol. The identity gate.
//
// THE RULE
//   Identity is a hard gate, not a score. Below threshold the generation is
//   rejected and retried — never shown. It is the one failure a user cannot
//   forgive, and unlike composition it is cheaply and objectively measurable.
//
// WHAT THIS FILE IS (and is not)
//   This is PURE DECISION LOGIC. It contains no model, no network, no DOM, no
//   image bytes. You hand it a measured identity distance, how many attempts
//   have already been made, and a config; it returns ACCEPT / RETRY / REJECT
//   plus the quota consequence and the copy to show. Everything that can be
//   wrong about a face detector is somebody else's file.
//
// WHY IT LIVES HERE, AT THE CLIENT ROOT
//   Because this is where the face embedding is actually computed. gems-faces.js
//   runs @vladmandic/face-api IN THE BROWSER: TinyFaceDetector → 68 landmarks →
//   a 128-d recognition descriptor, compared by euclidean distance to the "me"
//   cluster centroid (faceDistanceToMe). The edge function has NO face model at
//   all — supabase/functions/_shared/gemini-embedding-rest-v1.ts produces a
//   SCENE-level image embedding used for anti-copy (scene-anti-copy-v1.ts), and
//   using a scene embedding to judge a face would be a category error: two
//   photos of the same rooftop score ~0.9 whoever is standing on it.
//   Putting the policy next to the measurement means the decision cannot drift
//   away from the number it is deciding on.
//
//   The file is nonetheless written as dependency-free ESM with zero browser
//   globals, so it imports unchanged into node (tool/identity-gate-eval.mjs) and
//   into Deno if the embedding ever moves server-side behind a real ArcFace.
//   That day the ONLY thing that changes is which metric preset is selected.
//
// WHAT THIS DOES NOT DO
//   A client-side gate is a QUALITY gate, not a SECURITY gate. It stops us from
//   showing a user a stranger's face; it does not stop a hostile client from
//   lying about its score. That is fine — the user is not attacking themselves.
//   But it is exactly why the QUOTA consequence of this decision must be
//   enforced server-side (see `consumesQuota` / `releaseQuota` below), never
//   taken on the client's word.

export const IDENTITY_GATE_POLICY_VERSION = "identity-gate-v1";

/** A retry is OUR cost of quality, not the user's. Mirrors the anti-copy loop's
 *  `fundingSource: "system_anti_copy"` in scene-generation-loop-v1.ts. */
export const IDENTITY_RETRY_FUNDING = "system_identity_gate";

// ---------------------------------------------------------------------------
// Metrics.
//
// Every metric here is a DISTANCE: lower is better, 0 is identical. That
// convention is not arbitrary — it is the one the database already speaks.
// `generation_identity_evaluations` (20260828000000_generation_integrity_v1.sql)
// stores `distance` + `threshold` with a CHECK constraint deriving
// `passed = (distance <= threshold)`, so SQL and this module cannot disagree
// about which direction is good. Similarity-shaped scores are converted at the
// boundary by identityDistanceFromCosineSimilarity().
// ---------------------------------------------------------------------------

export const IDENTITY_METRICS = Object.freeze({
  /**
   * WHAT WE ACTUALLY SHIP ON TODAY.
   * face-api.js / dlib-lineage 128-d descriptor, euclidean distance.
   *
   * accept 0.55 / reject 0.60 — the reasoning:
   *   • dlib's published operating point is 0.6: at that threshold the model
   *     scores 99.38% on LFW, and its own guidance is "same person < ~0.6".
   *     That is a REAL, externally-calibrated boundary, so it is the hard gate.
   *     Above 0.6 we are not making a judgement call, we are quoting the model:
   *     this is not that person.
   *   • 0.55 is the confidence band, not a second gate. It is where the existing
   *     product already drew "good" (GOOD_DIST in gems-scene-view.js and GOOD in
   *     gems-batch-view.js), and it leaves headroom for the two extra sources of
   *     noise this comparison has and LFW does not: we compare a GENERATED face
   *     against a CENTROID of several real photos, so error accumulates on both
   *     sides of the subtraction.
   *   • gems-faces.js clusters at 0.56. Clustering and gating want the same
   *     boundary for a different reason (don't merge two people vs. don't ship
   *     two people), and 0.55/0.56 are the same number to within the noise. The
   *     three numbers scattered across the codebase today — 0.55 (scene-view),
   *     0.56 (clustering), 0.62 (editor.js warning) — collapse to this pair.
   *   • 0.62, the editor's current warning threshold, is ABOVE dlib's own
   *     same-person line. It is measurably too permissive and is retired here.
   */
  faceapi_euclidean_128: Object.freeze({
    name: "faceapi_euclidean_128",
    kind: "euclidean",
    accept: 0.55,
    reject: 0.6,
    // 128-d descriptors are not unit-normalised; observed distances live in
    // roughly 0..1.5. 4 is a generous sanity bound — beyond it the caller has
    // handed us something that is not a descriptor distance.
    maximum: 4,
    calibrated: true,
  }),

  /**
   * THE FORWARD PATH, NOT YET IN USE. ArcFace R100 / AdaFace class embedding,
   * cosine DISTANCE (= 1 − cosine similarity), the scale the identity-preservation
   * literature reports on.
   *
   * Published anchors on this scale (lower = better identity preservation):
   *   InfiniteYou        0.209
   *   PuLID-FLUX         0.225
   *   FLUX IP-Adapter    0.772   ← the "it's a different person" baseline
   *
   * accept 0.30: a generator performing at or near the published state of the
   *   art lands at 0.21–0.23. 0.30 sits just outside that cluster, so "as good
   *   as the best published method, plus a margin" is what earns an immediate
   *   ship.
   * reject 0.45: deliberately set nearer the SOTA cluster than the midpoint to
   *   the 0.772 no-identity baseline (the midpoint, ~0.49, would be lenient).
   *   0.45 is more than twice the SOTA distance and already past the cosine
   *   distance where 1:1 ArcFace verification stops holding at a practical
   *   false-accept rate for good frontal pairs.
   *
   * MARKED UNCALIBRATED ON PURPOSE. These numbers are read off other people's
   * papers, on other people's benchmarks, against a model we do not yet run.
   * They are a starting point for a sweep on our own golden set, not a result.
   * assertIdentityMetricCalibrated() exists so nobody ships them by accident.
   */
  arcface_cosine_distance: Object.freeze({
    name: "arcface_cosine_distance",
    kind: "cosine_distance",
    accept: 0.3,
    reject: 0.45,
    maximum: 2, // cosine similarity ∈ [-1, 1] ⇒ distance ∈ [0, 2]
    calibrated: false,
  }),
});

export const DEFAULT_IDENTITY_METRIC = "faceapi_euclidean_128";

/**
 * How many provider calls a single delivered image may cost us.
 *
 * 3 (i.e. two retries). The reasoning, because this number is money:
 *   • Identity drift is mostly a STOCHASTIC per-sample failure. At a plausible
 *     per-attempt failure rate of ~15%, one attempt leaves 15% of users looking
 *     at a stranger, two leaves 2.25%, three leaves 0.34%. Three is where the
 *     residual stops being a product problem.
 *   • A fourth attempt buys ~0.05 percentage points for a 33% cost increase and
 *     pushes p95 latency past a minute of spinner. That is a bad trade in both
 *     currencies.
 *   • More importantly, by the third consecutive failure the cause is almost
 *     never randomness — it is systematic (sunglasses, a profile-only "me"
 *     cluster, a heavily stylised pack, a source photo where the face is 40px
 *     wide). Extra samples cannot fix a systematic cause; they just spend money
 *     confirming it. Retrying past the point where retrying works is the actual
 *     way this bankrupts us.
 */
export const IDENTITY_MAX_ATTEMPTS = 3;

/**
 * A MARGINAL result (inside the hard gate but outside the confidence band) gets
 * at most ONE extra sample, not the full ladder. A marginal image is already
 * shippable — the model itself says it is the same person — so a second reroll
 * is pure spend on diminishing returns. A hard-gate FAILURE is unshippable, so
 * it is worth every attempt in the budget. Different failures, different ladders.
 */
export const IDENTITY_MAX_MARGINAL_ATTEMPTS = 2;

/**
 * Wall-clock ceiling on the whole gate loop. "Never an infinite spinner" is a
 * requirement, and a retry ladder is exactly how a spinner becomes infinite when
 * the provider is slow. A pro scene generation runs ~10–25s, so three attempts
 * plus measurement fits inside 90s with room; past that we stop retrying and
 * settle with whatever we have (best-so-far if it clears the gate, otherwise a
 * clean rejection). The deadline can only ever REDUCE spend and latency.
 */
export const IDENTITY_DEADLINE_MS = 90_000;

export class IdentityGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IdentityGateError";
    this.code = code;
  }
}

/** Cosine similarity → the distance this module speaks. */
export function identityDistanceFromCosineSimilarity(similarity) {
  if (!Number.isFinite(similarity) || similarity < -1 || similarity > 1) {
    throw new IdentityGateError(
      "invalid_score",
      "cosine similarity is outside [-1, 1]",
    );
  }
  return 1 - similarity;
}

/**
 * Build (and validate) a gate config. Overrides exist for the calibration sweep;
 * they are validated exactly as hard as the presets, because a config that
 * accidentally sets accept > reject would silently invert the gate.
 */
export function identityGateConfig(metricName = DEFAULT_IDENTITY_METRIC, overrides = {}) {
  const metric = IDENTITY_METRICS[metricName];
  if (!metric) {
    throw new IdentityGateError("invalid_config", `unknown identity metric: ${metricName}`);
  }
  const config = {
    policyVersion: IDENTITY_GATE_POLICY_VERSION,
    metric: metric.name,
    metricKind: metric.kind,
    maximum: metric.maximum,
    calibrated: metric.calibrated,
    accept: metric.accept,
    reject: metric.reject,
    maxAttempts: IDENTITY_MAX_ATTEMPTS,
    maxMarginalAttempts: IDENTITY_MAX_MARGINAL_ATTEMPTS,
    deadlineMs: IDENTITY_DEADLINE_MS,
    // Two of the user in one frame is as unforgivable as none of them. On by
    // default; see the duplicate-subject note in decideIdentityGate().
    rejectDuplicateSubject: true,
    ...overrides,
  };

  const positive = (v) => Number.isFinite(v) && v > 0;
  if (!positive(config.accept) || !positive(config.reject)) {
    throw new IdentityGateError("invalid_config", "thresholds must be positive numbers");
  }
  if (config.accept > config.reject) {
    throw new IdentityGateError(
      "invalid_config",
      "accept threshold must be at or below the reject threshold",
    );
  }
  if (config.reject > config.maximum) {
    throw new IdentityGateError("invalid_config", "reject threshold exceeds the metric's range");
  }
  if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1) {
    throw new IdentityGateError("invalid_config", "maxAttempts must be a positive integer");
  }
  if (
    !Number.isSafeInteger(config.maxMarginalAttempts) ||
    config.maxMarginalAttempts < 1 ||
    config.maxMarginalAttempts > config.maxAttempts
  ) {
    throw new IdentityGateError(
      "invalid_config",
      "maxMarginalAttempts must be a positive integer no greater than maxAttempts",
    );
  }
  if (!positive(config.deadlineMs)) {
    throw new IdentityGateError("invalid_config", "deadlineMs must be a positive number");
  }
  return Object.freeze(config);
}

/** Refuse to run a gate on thresholds nobody has measured on our own data. */
export function assertIdentityMetricCalibrated(config) {
  if (!config.calibrated) {
    throw new IdentityGateError(
      "uncalibrated_metric",
      `${config.metric} thresholds are borrowed from published benchmarks and have not been swept on our golden set`,
    );
  }
}

// ---------------------------------------------------------------------------
// Observation.
//
// The bridge from "what the face model returned" to "what the policy reasons
// about". Still pure: it takes numbers, not bitmaps.
// ---------------------------------------------------------------------------

export const IDENTITY_MEASUREMENTS = Object.freeze([
  "ok",
  "no_face_in_output",
  "no_source_identity",
  "model_unavailable",
  "measurement_failed",
]);

/**
 * Normalise a list of per-face distances from the output image into an
 * observation. `distances` is one entry per detected face, each the distance
 * from that face to the user's identity centroid.
 *
 * gems-faces.js#faceDistanceToMe currently collapses this to a single minimum
 * before returning, which is why it cannot see a duplicated subject. Wiring
 * R22 means returning the per-face list (see the report), not changing anything
 * about how the descriptors are computed.
 */
export function observeFaceDistances(distances, config, options = {}) {
  const subjectRequested = options.subjectRequested !== false;
  const base = {
    subjectRequested,
    attemptsMade: options.attemptsMade ?? 1,
    bestSoFar: options.bestSoFar ?? null,
    elapsedMs: options.elapsedMs ?? 0,
  };
  if (!subjectRequested) {
    return { ...base, measurement: "ok", distance: null, facesInOutput: 0, clearingFaces: 0 };
  }
  if (!Array.isArray(distances)) {
    // A null/undefined result from the measurement layer is an ABSENCE of a
    // measurement, not a measurement of zero. Never let it read as a pass.
    return { ...base, measurement: "measurement_failed", distance: null, facesInOutput: 0, clearingFaces: 0 };
  }
  if (distances.length === 0) {
    return { ...base, measurement: "no_face_in_output", distance: null, facesInOutput: 0, clearingFaces: 0 };
  }
  let best = Infinity;
  let clearing = 0;
  for (const d of distances) {
    if (!Number.isFinite(d) || d < 0 || d > config.maximum) {
      throw new IdentityGateError(
        "invalid_score",
        `identity distance ${d} is outside the ${config.metric} range [0, ${config.maximum}]`,
      );
    }
    if (d < best) best = d;
    if (d <= config.accept) clearing += 1;
  }
  return {
    ...base,
    measurement: "ok",
    distance: best,
    facesInOutput: distances.length,
    clearingFaces: clearing,
  };
}

// ---------------------------------------------------------------------------
// The decision.
// ---------------------------------------------------------------------------

const OUTCOME = Object.freeze({ ACCEPT: "accept", RETRY: "retry", REJECT: "reject" });
export const IDENTITY_OUTCOMES = OUTCOME;

const COPY = Object.freeze({
  confirmed: "Matched to your face ✓",
  marginal: "Closest match to your face — make another if it looks off.",
  // The rejection copy has three jobs, in this order: say it plainly, say the
  // money is safe (the user reserved a slot and we are about to release it), and
  // give the ONE action that actually fixes a systematic identity failure.
  rejected:
    "We couldn’t get your face right in this one, so we didn’t show it — and it didn’t use up a creation. Try a clear, front-on photo of yourself.",
  unenrolled:
    "Tag yourself in Photos and we’ll check every generation actually looks like you.",
  degraded: "",
});

function result(fields) {
  return Object.freeze({
    policyVersion: IDENTITY_GATE_POLICY_VERSION,
    ...fields,
  });
}

/**
 * The gate.
 *
 * @param {object} observation
 *   {string}        measurement      one of IDENTITY_MEASUREMENTS
 *   {number|null}   distance         this attempt's best face distance
 *   {number}        facesInOutput
 *   {number}        clearingFaces    faces at or under the accept threshold
 *   {boolean}       subjectRequested false for background/no-subject scenes
 *   {number}        attemptsMade     attempts completed INCLUDING this one (1-based)
 *   {number|null}   bestSoFar        lowest distance across every attempt so far
 *   {number}        elapsedMs        wall clock since the loop started
 * @param {object} config from identityGateConfig()
 * @returns {{outcome:"accept"|"retry"|"reject", deliver:"current"|"best"|"none", ...}}
 *
 * INVARIANTS (asserted exhaustively in tool/identity-gate-eval.mjs):
 *   1. deliver === "none"  ⇔  outcome === "reject"
 *   2. a delivered VERIFIED image always has deliveredDistance <= config.reject
 *   3. exactly one of consumesQuota / releaseQuota is true on a terminal
 *      outcome; both are false on a retry
 */
export function decideIdentityGate(observation, config) {
  if (!config || config.policyVersion !== IDENTITY_GATE_POLICY_VERSION) {
    throw new IdentityGateError("invalid_config", "decideIdentityGate requires an identityGateConfig()");
  }
  const {
    measurement,
    distance,
    facesInOutput = 0,
    clearingFaces = 0,
    subjectRequested = true,
    attemptsMade,
    bestSoFar = null,
    elapsedMs = 0,
  } = observation ?? {};

  if (!IDENTITY_MEASUREMENTS.includes(measurement)) {
    throw new IdentityGateError("invalid_observation", `unknown measurement: ${measurement}`);
  }
  if (!Number.isSafeInteger(attemptsMade) || attemptsMade < 1) {
    throw new IdentityGateError("invalid_observation", "attemptsMade must be a positive integer");
  }
  if (attemptsMade > config.maxAttempts) {
    throw new IdentityGateError(
      "invalid_observation",
      "attemptsMade exceeds the configured attempt budget — the caller ran an unauthorised retry",
    );
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new IdentityGateError("invalid_observation", "elapsedMs must be a non-negative number");
  }

  const attemptsRemaining = config.maxAttempts - attemptsMade;
  const withinDeadline = elapsedMs < config.deadlineMs;

  const common = {
    metric: config.metric,
    threshold: config.reject,
    confidenceThreshold: config.accept,
    distance: distance ?? null,
    facesInOutput,
    attemptsMade,
    attemptsRemaining,
    retryFunding: IDENTITY_RETRY_FUNDING,
  };

  const accept = (fields) =>
    result({
      ...common,
      outcome: OUTCOME.ACCEPT,
      deliver: fields.deliver ?? "current",
      consumesQuota: true,
      releaseQuota: false,
      ...fields,
    });
  const retry = (fields) =>
    result({
      ...common,
      outcome: OUTCOME.RETRY,
      deliver: "none",
      // A retry must NOT reserve a second slot and must NOT release the first.
      // The user paid for one delivered image; the extra provider calls are ours.
      consumesQuota: false,
      releaseQuota: false,
      verified: true,
      degraded: false,
      deliveredDistance: null,
      userMessage: "",
      severity: "none",
      ...fields,
    });
  const reject = (fields) =>
    result({
      ...common,
      outcome: OUTCOME.REJECT,
      deliver: "none",
      consumesQuota: false,
      // The reserved free-tier slot is RELEASED. This is the same contract
      // generate-scene's releaseSlot() already applies to every other failure:
      // "a failed generation never consumes the free request". An image the user
      // was never shown is a failed generation. Charging for it would be the
      // silent charge the rule forbids.
      releaseQuota: true,
      deliveredDistance: null,
      severity: "error",
      ...fields,
    });

  // ---- 0. The gate does not apply to scenes with no person in them. --------
  // generate-scene's `mode: "background"` renders an empty aesthetic scene; there
  // is no face to get wrong, so an identity gate there would reject 100% of a
  // perfectly good product surface.
  if (!subjectRequested) {
    return accept({
      reason: "gate_not_applicable",
      verified: false,
      degraded: false,
      deliveredDistance: null,
      userMessage: "",
      severity: "none",
    });
  }

  // ---- 1. FAIL OPEN — the measurement apparatus is unavailable. ------------
  // face-api loads its weights from a public CDN into the user's browser. A CDN
  // blip, a corporate proxy, a browser without WASM, an OOM on a cheap phone —
  // any of these means we cannot measure. Failing CLOSED here would take the
  // entire product down for that user for a reason that has nothing to do with
  // their image.
  //
  // We also do NOT retry: a retry cannot repair an absent measurement, it just
  // buys another unmeasurable image. This is the one path where the attempt
  // budget is irrelevant.
  //
  // The cost of failing open is that the gate silently stops protecting. So it
  // is not silent: verified=false and degraded=true travel with the result, and
  // the caller is expected to emit them. A global model outage should show up as
  // a cliff in the verified rate, not as nothing at all.
  if (measurement === "model_unavailable" || measurement === "measurement_failed") {
    return accept({
      reason:
        measurement === "model_unavailable"
          ? "unverified_model_unavailable"
          : "unverified_measurement_failed",
      verified: false,
      degraded: true,
      deliveredDistance: null,
      userMessage: COPY.degraded,
      severity: "none",
    });
  }

  // ---- 2. FAIL OPEN — there is no source identity to compare against. ------
  // No "me" cluster tagged, or no face detectable in the user's own reference
  // photos. This is ABSENCE OF EVIDENCE, not evidence of a wrong face, and it is
  // the DEFAULT state of every new account (hasMeIdentity() is false until the
  // user tags a person). Failing closed would mean nobody can generate anything
  // until they complete an optional onboarding step — the product would ship
  // broken for its entire top-of-funnel.
  //
  // Distinguished from case 1 by degraded=false: nothing is broken, the user
  // simply has not enrolled. That is a nudge, not an incident.
  if (measurement === "no_source_identity") {
    return accept({
      reason: "unverified_no_source_identity",
      verified: false,
      degraded: false,
      deliveredDistance: null,
      userMessage: COPY.unenrolled,
      severity: "info",
    });
  }

  // ---- 3. FAIL CLOSED — no face in an image that was supposed to have one. --
  // We asked for the user in a scene and got back an image with no detectable
  // face. Either it is not a photo of a person, or the face is so distorted or
  // occluded that a detector will not call it a face — and a face a detector
  // refuses is not a face a user will accept.
  //
  // This MUST fail closed for a structural reason as well as a product one: if
  // "no face" failed open, the cheapest possible way for a generator to satisfy
  // the identity gate would be to stop rendering faces. A gate whose easiest
  // pass is degenerate is not a gate.
  if (measurement === "no_face_in_output") {
    if (attemptsRemaining > 0 && withinDeadline) {
      return retry({ reason: "no_face_in_output_retrying" });
    }
    return settleExhausted("no_face_in_output", bestSoFar);
  }

  // ---- 4. A real measurement. ----------------------------------------------
  if (!Number.isFinite(distance) || distance < 0 || distance > config.maximum) {
    throw new IdentityGateError(
      "invalid_score",
      `measurement "ok" requires a distance within [0, ${config.maximum}], got ${distance}`,
    );
  }

  // ---- 4a. FAIL CLOSED — the user rendered twice. --------------------------
  // Multiple faces in the output is NORMAL and fails open on the general case:
  // "put me on a rooftop with friends" legitimately contains strangers, and we
  // gate on the best-matching face only. Rejecting because a bystander does not
  // look like the user would break group scenes outright.
  //
  // The one exception is TWO faces that BOTH clear the confidence band, i.e. the
  // subject duplicated into the frame — a well-known failure of identity-
  // conditioned diffusion, and one the user cannot forgive for the same reason a
  // wrong face is unforgivable. It is deliberately keyed on the confident band,
  // not the marginal one, so a sibling or a lookalike in a group shot does not
  // trip it; and the cost of a false positive is one retry, not a rejection.
  if (config.rejectDuplicateSubject && clearingFaces >= 2) {
    if (attemptsRemaining > 0 && withinDeadline) {
      return retry({ reason: "duplicate_subject_retrying" });
    }
    return settleExhausted("duplicate_subject", bestSoFar);
  }

  // ---- 4b. Below the hard gate. THIS is the rule. --------------------------
  // Strictly greater-than, so a distance exactly equal to the threshold passes —
  // matching the SQL `passed = (distance <= threshold)` in
  // generation_identity_evaluations, and matching scene-anti-copy-v1.ts's
  // deliberate choice to accept exactly-at-threshold.
  if (distance > config.reject) {
    if (attemptsRemaining > 0 && withinDeadline) {
      return retry({ reason: "identity_failed_retrying" });
    }
    return settleExhausted("identity_failed", bestSoFar);
  }

  const best = bestSoFar === null ? distance : Math.min(bestSoFar, distance);

  // ---- 4c. Marginal: inside the gate, outside the confidence band. ---------
  // Shippable — the model itself says this is the same person — but not proudly
  // so. Worth ONE more sample, then ship the better of the two.
  if (distance > config.accept) {
    if (
      attemptsMade < config.maxMarginalAttempts &&
      attemptsRemaining > 0 &&
      withinDeadline
    ) {
      return retry({ reason: "identity_marginal_retrying" });
    }
    return accept({
      reason: "identity_marginal_delivered",
      deliver: best < distance ? "best" : "current",
      deliveredDistance: best,
      verified: true,
      degraded: false,
      userMessage: best <= config.accept ? COPY.confirmed : COPY.marginal,
      severity: best <= config.accept ? "none" : "info",
    });
  }

  // ---- 4d. Confirmed. Stop spending. --------------------------------------
  return accept({
    reason: "identity_confirmed",
    deliver: "current",
    deliveredDistance: distance,
    verified: true,
    degraded: false,
    userMessage: COPY.confirmed,
    severity: "none",
  });

  /**
   * The budget (or the clock) ran out on a CLOSED failure. There are two honest
   * endings, and picking between them is the whole point of tracking bestSoFar:
   *
   *   • Some earlier attempt cleared the hard gate → deliver THAT one. It passed
   *     the gate; discarding a passing image because a later sample failed would
   *     charge the user for our retry policy's bad luck.
   *   • Nothing ever cleared → REJECT. No image, no charge, a real message. This
   *     is the branch the rule is actually about: we would rather hand the user
   *     nothing than hand them a stranger wearing their name.
   */
  function settleExhausted(kind, carriedBest) {
    const deliverable = carriedBest !== null && carriedBest <= config.reject;
    if (deliverable) {
      return accept({
        reason: `${kind}_settled_on_best`,
        deliver: "best",
        deliveredDistance: carriedBest,
        verified: true,
        degraded: false,
        userMessage: carriedBest <= config.accept ? COPY.confirmed : COPY.marginal,
        severity: carriedBest <= config.accept ? "none" : "info",
      });
    }
    return reject({
      reason: `${kind}_exhausted`,
      verified: true,
      degraded: false,
      userMessage: COPY.rejected,
    });
  }
}

/**
 * The row this decision should write to `generation_identity_evaluations` via
 * the existing record_scene_identity_evaluation RPC. Returns null when there is
 * nothing measured to record (unverified paths) — an unverified generation must
 * not write a `distance` the SQL CHECK would then turn into a `passed` label.
 */
export function identityEvaluationRecord(decision) {
  if (!decision.verified || decision.deliveredDistance === null) return null;
  return Object.freeze({
    evaluator_version: `${decision.policyVersion}:${decision.metric}`,
    distance: decision.deliveredDistance,
    threshold: decision.threshold,
    // Derived here only to assert agreement; the SQL CHECK constraint is the
    // authority and will reject the insert if these ever disagree.
    passed: decision.deliveredDistance <= decision.threshold,
  });
}
