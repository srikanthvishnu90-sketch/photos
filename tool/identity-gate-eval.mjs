// Identity gate — R22 acceptance eval. Pure policy, no model, so it runs anywhere:
//   node tool/identity-gate-eval.mjs
//
// The gate is the one check whose failure a user cannot forgive, so this eval is
// exhaustive rather than illustrative: every threshold boundary (including the
// exact-equality cases), the full retry ladder for both failure classes, the
// quota consequence of every terminal outcome, every degenerate measurement, and
// a brute-force sweep asserting the three safety invariants over the whole
// cross-product of reachable states.
import {
  IDENTITY_GATE_POLICY_VERSION,
  IDENTITY_METRICS,
  IDENTITY_MEASUREMENTS,
  IDENTITY_MAX_ATTEMPTS,
  IDENTITY_MAX_MARGINAL_ATTEMPTS,
  IDENTITY_RETRY_FUNDING,
  IdentityGateError,
  identityGateConfig,
  assertIdentityMetricCalibrated,
  identityDistanceFromCosineSimilarity,
  observeFaceDistances,
  decideIdentityGate,
  identityEvaluationRecord,
} from "../gems-identity-gate.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const throws = (name, fn, code) => {
  try { fn(); ok(name, false, "did not throw"); }
  catch (error) {
    ok(name, error instanceof IdentityGateError && (!code || error.code === code),
      `${error?.name}:${error?.code}`);
  }
};

const cfg = identityGateConfig();
const ACCEPT = cfg.accept;   // 0.55
const REJECT = cfg.reject;   // 0.60
const EPS = 1e-6;

// One observation builder so every test below differs only in what it means to.
const obs = (over = {}) => ({
  measurement: "ok",
  distance: 0.1,
  facesInOutput: 1,
  clearingFaces: 1,
  subjectRequested: true,
  attemptsMade: 1,
  bestSoFar: null,
  elapsedMs: 0,
  ...over,
});
const decide = (over = {}, config = cfg) => decideIdentityGate(obs(over), config);

console.log(`Identity gate — ${IDENTITY_GATE_POLICY_VERSION} on ${cfg.metric}`);
console.log(`  accept <= ${ACCEPT}   hard gate <= ${REJECT}   attempts ${cfg.maxAttempts} (marginal ${cfg.maxMarginalAttempts})   deadline ${cfg.deadlineMs}ms\n`);

// ---------------------------------------------------------------------------
// Config + metric hygiene. A misconfigured gate is worse than none: it looks
// like it is protecting.
// ---------------------------------------------------------------------------
ok("default metric is the one we actually run", cfg.metric === "faceapi_euclidean_128");
ok("default metric is calibrated", cfg.calibrated === true);
ok("shipping metric passes the calibration assert",
  (() => { try { assertIdentityMetricCalibrated(cfg); return true; } catch { return false; } })());
throws("borrowed ArcFace thresholds cannot ship unswept",
  () => assertIdentityMetricCalibrated(identityGateConfig("arcface_cosine_distance")),
  "uncalibrated_metric");
for (const m of Object.values(IDENTITY_METRICS)) {
  ok(`${m.name}: accept below reject`, m.accept < m.reject, `${m.accept} / ${m.reject}`);
  ok(`${m.name}: reject inside metric range`, m.reject < m.maximum);
}
// The published anchors the ArcFace preset is calibrated against. If someone
// moves the thresholds, these say what they are moving relative to.
const arc = IDENTITY_METRICS.arcface_cosine_distance;
ok("ArcFace accept sits above published SOTA (InfiniteYou 0.209 / PuLID 0.225)",
  arc.accept > 0.225, `accept ${arc.accept}`);
ok("ArcFace reject sits far below the no-identity baseline (IP-Adapter 0.772)",
  arc.reject < 0.772 / 1.5, `reject ${arc.reject}`);

throws("unknown metric rejected", () => identityGateConfig("nope"), "invalid_config");
throws("inverted thresholds rejected",
  () => identityGateConfig(cfg.metric, { accept: 0.7, reject: 0.5 }), "invalid_config");
throws("reject beyond metric range rejected",
  () => identityGateConfig(cfg.metric, { reject: 99 }), "invalid_config");
throws("zero attempts rejected",
  () => identityGateConfig(cfg.metric, { maxAttempts: 0 }), "invalid_config");
throws("marginal ladder longer than the real ladder rejected",
  () => identityGateConfig(cfg.metric, { maxAttempts: 2, maxMarginalAttempts: 3 }), "invalid_config");
throws("non-positive deadline rejected",
  () => identityGateConfig(cfg.metric, { deadlineMs: 0 }), "invalid_config");
throws("a raw object is not a config", () => decideIdentityGate(obs(), { accept: 0.5 }), "invalid_config");
ok("accept === reject is legal (single-threshold mode)",
  identityGateConfig(cfg.metric, { accept: 0.6, reject: 0.6 }).accept === 0.6);

// ---------------------------------------------------------------------------
// Similarity → distance conversion. The research scale is a similarity; the
// database column is a distance. Getting this backwards inverts the gate.
// ---------------------------------------------------------------------------
ok("cosine 1.0 → distance 0", identityDistanceFromCosineSimilarity(1) === 0);
ok("cosine 0.791 → the InfiniteYou anchor 0.209",
  Math.abs(identityDistanceFromCosineSimilarity(0.791) - 0.209) < 1e-9);
ok("cosine -1 → distance 2", identityDistanceFromCosineSimilarity(-1) === 2);
throws("out-of-range similarity rejected", () => identityDistanceFromCosineSimilarity(1.5), "invalid_score");
throws("NaN similarity rejected", () => identityDistanceFromCosineSimilarity(NaN), "invalid_score");

// ---------------------------------------------------------------------------
// Threshold boundaries. Every side of both numbers, plus exact equality — the
// case that decides whether the gate agrees with the SQL CHECK constraint.
// ---------------------------------------------------------------------------
ok("distance 0 → accept", decide({ distance: 0 }).outcome === "accept");
ok("just inside the confidence band → accept confirmed",
  decide({ distance: ACCEPT - EPS }).reason === "identity_confirmed");
ok("EXACTLY at the confidence threshold → confirmed (<=, matches SQL)",
  decide({ distance: ACCEPT }).reason === "identity_confirmed");
ok("just past the confidence threshold → not confirmed",
  decide({ distance: ACCEPT + EPS }).reason !== "identity_confirmed");
ok("marginal on the last attempt → delivered, not rejected",
  decide({ distance: ACCEPT + EPS, attemptsMade: IDENTITY_MAX_ATTEMPTS }).outcome === "accept");
ok("EXACTLY at the hard gate → still inside the gate (<=, matches SQL)",
  decide({ distance: REJECT, attemptsMade: IDENTITY_MAX_ATTEMPTS }).outcome === "accept");
ok("one epsilon past the hard gate on the last attempt → REJECT",
  decide({ distance: REJECT + EPS, attemptsMade: IDENTITY_MAX_ATTEMPTS }).outcome === "reject");
ok("a delivered image at the hard gate is still marked verified",
  decide({ distance: REJECT, attemptsMade: IDENTITY_MAX_ATTEMPTS }).verified === true);
ok("the recorded threshold is the HARD gate, not the confidence band",
  decide({ distance: 0.1 }).threshold === REJECT);
ok("the confidence band is reported separately",
  decide({ distance: 0.1 }).confidenceThreshold === ACCEPT);

throws("NaN distance with measurement ok is a programmer error, not a pass",
  () => decide({ distance: NaN }), "invalid_score");
throws("negative distance rejected", () => decide({ distance: -0.1 }), "invalid_score");
throws("distance beyond the metric range rejected", () => decide({ distance: 99 }), "invalid_score");
throws("unknown measurement rejected", () => decide({ measurement: "vibes" }), "invalid_observation");
throws("attemptsMade 0 rejected", () => decide({ attemptsMade: 0 }), "invalid_observation");
throws("an unauthorised extra retry is caught",
  () => decide({ attemptsMade: IDENTITY_MAX_ATTEMPTS + 1 }), "invalid_observation");
throws("negative elapsed time rejected", () => decide({ elapsedMs: -1 }), "invalid_observation");

// ---------------------------------------------------------------------------
// The retry ladder — hard failures get the full budget.
// ---------------------------------------------------------------------------
const hard = REJECT + 0.2;
for (let attempt = 1; attempt < IDENTITY_MAX_ATTEMPTS; attempt += 1) {
  const d = decide({ distance: hard, attemptsMade: attempt, bestSoFar: hard });
  ok(`hard failure, attempt ${attempt}/${IDENTITY_MAX_ATTEMPTS} → retry`, d.outcome === "retry");
  ok(`hard failure, attempt ${attempt} → nothing delivered`, d.deliver === "none");
  ok(`hard failure, attempt ${attempt} → ${IDENTITY_MAX_ATTEMPTS - attempt} attempts left`,
    d.attemptsRemaining === IDENTITY_MAX_ATTEMPTS - attempt);
  ok(`hard failure, attempt ${attempt} → retry is system funded`,
    d.retryFunding === IDENTITY_RETRY_FUNDING);
}
const exhausted = decide({ distance: hard, attemptsMade: IDENTITY_MAX_ATTEMPTS, bestSoFar: hard });
ok("hard failure on the final attempt → reject", exhausted.outcome === "reject");
ok("rejection reason names the failure class", exhausted.reason === "identity_failed_exhausted");
ok("rejection shows nothing", exhausted.deliver === "none");
ok("rejection carries user-facing copy", exhausted.userMessage.length > 20);
ok("rejection copy promises no charge", /didn’t use up|didn't use up/.test(exhausted.userMessage));
ok("rejection copy gives an action", /front-on|photo of yourself/.test(exhausted.userMessage));
ok("rejection severity is error", exhausted.severity === "error");

// A single-attempt config never retries — the ladder is configuration, not a
// hardcoded 2 like the four copies of this loop in the client today.
const single = identityGateConfig(cfg.metric, { maxAttempts: 1, maxMarginalAttempts: 1 });
ok("maxAttempts 1: a hard failure rejects immediately",
  decideIdentityGate(obs({ distance: hard, attemptsMade: 1, bestSoFar: hard }), single).outcome === "reject");
const long = identityGateConfig(cfg.metric, { maxAttempts: 5, maxMarginalAttempts: 2 });
ok("maxAttempts 5: still retrying at attempt 4",
  decideIdentityGate(obs({ distance: hard, attemptsMade: 4, bestSoFar: hard }), long).outcome === "retry");

// ---------------------------------------------------------------------------
// The marginal ladder — shippable results get ONE extra sample, not the budget.
// ---------------------------------------------------------------------------
const marginal = (ACCEPT + REJECT) / 2;
ok("marginal, attempt 1 → retry once",
  decide({ distance: marginal, attemptsMade: 1, bestSoFar: marginal }).reason === "identity_marginal_retrying");
ok("marginal, attempt 2 → stop and ship (marginal ladder spent)",
  decide({ distance: marginal, attemptsMade: IDENTITY_MAX_MARGINAL_ATTEMPTS, bestSoFar: marginal })
    .outcome === "accept");
ok("marginal ladder is shorter than the hard ladder",
  decide({ distance: marginal, attemptsMade: 2, bestSoFar: marginal }).outcome === "accept" &&
  decide({ distance: hard, attemptsMade: 2, bestSoFar: hard }).outcome === "retry",
  "a shippable image must not cost as many retries as an unshippable one");
ok("marginal delivery is honest about being marginal",
  decide({ distance: marginal, attemptsMade: 2, bestSoFar: marginal }).userMessage.includes("Closest match"));
ok("marginal delivery is severity info, not error",
  decide({ distance: marginal, attemptsMade: 2, bestSoFar: marginal }).severity === "info");

// ---------------------------------------------------------------------------
// best-so-far. The retry ladder must never make the user worse off than the
// best sample it already produced.
// ---------------------------------------------------------------------------
const rescued = decide({ distance: hard, attemptsMade: IDENTITY_MAX_ATTEMPTS, bestSoFar: 0.5 });
ok("last attempt fails but an earlier one passed → deliver the earlier one",
  rescued.outcome === "accept" && rescued.deliver === "best");
ok("the rescued delivery reports the delivered distance, not the failed one",
  rescued.deliveredDistance === 0.5 && rescued.distance === hard);
ok("a rescued confident image gets confident copy", rescued.userMessage.includes("Matched"));
ok("a rescued image still consumes exactly one slot", rescued.consumesQuota === true);
const rescuedMarginal = decide({ distance: hard, attemptsMade: IDENTITY_MAX_ATTEMPTS, bestSoFar: REJECT });
ok("a rescued image exactly at the gate is deliverable", rescuedMarginal.outcome === "accept");
ok("a rescued image past the gate is NOT deliverable",
  decide({ distance: hard, attemptsMade: IDENTITY_MAX_ATTEMPTS, bestSoFar: REJECT + EPS }).outcome === "reject");
ok("marginal now, better earlier → ship the better one",
  decide({ distance: marginal, attemptsMade: 2, bestSoFar: 0.2 }).deliveredDistance === 0.2);
ok("confirmed now → ship the current one even if an earlier was better",
  decide({ distance: 0.3, attemptsMade: 2, bestSoFar: 0.2 }).deliver === "current");

// ---------------------------------------------------------------------------
// The deadline. A retry ladder is how a spinner becomes infinite.
// ---------------------------------------------------------------------------
ok("under the deadline with budget left → retry",
  decide({ distance: hard, attemptsMade: 1, bestSoFar: hard, elapsedMs: cfg.deadlineMs - 1 })
    .outcome === "retry");
ok("past the deadline with budget left → stop retrying",
  decide({ distance: hard, attemptsMade: 1, bestSoFar: hard, elapsedMs: cfg.deadlineMs })
    .outcome !== "retry");
ok("past the deadline with nothing passing → reject, not spin",
  decide({ distance: hard, attemptsMade: 1, bestSoFar: hard, elapsedMs: cfg.deadlineMs })
    .outcome === "reject");
ok("past the deadline with something passing → ship it",
  decide({ distance: hard, attemptsMade: 1, bestSoFar: 0.4, elapsedMs: cfg.deadlineMs * 2 })
    .deliver === "best");
ok("the deadline also stops the marginal ladder",
  decide({ distance: marginal, attemptsMade: 1, bestSoFar: marginal, elapsedMs: cfg.deadlineMs })
    .outcome === "accept");

// ---------------------------------------------------------------------------
// Quota. Getting this wrong either bankrupts us on retries or charges users for
// images they never saw. It must match generate-scene's existing contract:
// the reserved taste_events row IS the meter, released on any failure.
// ---------------------------------------------------------------------------
const quotaCases = [
  ["confirmed", decide({ distance: 0.2 })],
  ["marginal delivered", decide({ distance: marginal, attemptsMade: 2, bestSoFar: marginal })],
  ["rescued best", rescued],
  ["retry (hard)", decide({ distance: hard, attemptsMade: 1, bestSoFar: hard })],
  ["retry (marginal)", decide({ distance: marginal, attemptsMade: 1, bestSoFar: marginal })],
  ["rejected", exhausted],
  ["unverified, no identity", decide({ measurement: "no_source_identity", distance: null })],
  ["unverified, model down", decide({ measurement: "model_unavailable", distance: null })],
  ["background scene", decide({ subjectRequested: false, distance: null })],
];
for (const [name, d] of quotaCases) {
  if (d.outcome === "retry") {
    ok(`quota: ${name} reserves nothing new`, d.consumesQuota === false);
    ok(`quota: ${name} keeps the slot reserved (does not release)`, d.releaseQuota === false);
  } else {
    ok(`quota: ${name} settles exactly one way`,
      d.consumesQuota !== d.releaseQuota, `consume=${d.consumesQuota} release=${d.releaseQuota}`);
  }
}
ok("quota: a rejection RELEASES the free slot (never a silent charge)",
  exhausted.releaseQuota === true && exhausted.consumesQuota === false);
ok("quota: a delivered image consumes exactly one slot however many attempts it took",
  rescued.consumesQuota === true && rescued.attemptsMade === IDENTITY_MAX_ATTEMPTS);
ok("quota: an unverified delivered image still consumes a slot (the user got their image)",
  decide({ measurement: "model_unavailable", distance: null }).consumesQuota === true);
ok("quota: every retry is labelled system-funded so it cannot be metered to the user",
  decide({ distance: hard, attemptsMade: 1, bestSoFar: hard }).retryFunding === IDENTITY_RETRY_FUNDING);

// ---------------------------------------------------------------------------
// Degenerate cases, and their fail-open / fail-closed direction.
// ---------------------------------------------------------------------------

// FAIL CLOSED — no face where a face was required.
const noFaceEarly = decide({ measurement: "no_face_in_output", distance: null, facesInOutput: 0, clearingFaces: 0 });
ok("no face in output → fails CLOSED (retries, never ships)",
  noFaceEarly.outcome === "retry" && noFaceEarly.deliver === "none");
const noFaceLast = decide({
  measurement: "no_face_in_output", distance: null, facesInOutput: 0, clearingFaces: 0,
  attemptsMade: IDENTITY_MAX_ATTEMPTS, bestSoFar: null,
});
ok("no face on the last attempt → reject", noFaceLast.outcome === "reject");
ok("no face reject names its cause", noFaceLast.reason === "no_face_in_output_exhausted");
ok("no face, but an earlier attempt had a good face → ship the earlier one",
  decide({
    measurement: "no_face_in_output", distance: null, facesInOutput: 0, clearingFaces: 0,
    attemptsMade: IDENTITY_MAX_ATTEMPTS, bestSoFar: 0.3,
  }).deliver === "best");

// FAIL OPEN — nothing to compare against.
const unenrolled = decide({ measurement: "no_source_identity", distance: null });
ok("no source identity → fails OPEN (delivers)", unenrolled.outcome === "accept");
ok("no source identity is marked unverified", unenrolled.verified === false);
ok("no source identity is NOT marked degraded (it is an un-onboarded user, not an incident)",
  unenrolled.degraded === false);
ok("no source identity nudges the user to enrol", unenrolled.userMessage.includes("Tag yourself"));
ok("no source identity never retries (a retry cannot create a reference face)",
  decide({ measurement: "no_source_identity", distance: null, attemptsMade: 1 }).outcome === "accept");

// FAIL OPEN — the apparatus is broken.
for (const m of ["model_unavailable", "measurement_failed"]) {
  const d = decide({ measurement: m, distance: null });
  ok(`${m} → fails OPEN (delivers)`, d.outcome === "accept");
  ok(`${m} is marked unverified`, d.verified === false);
  ok(`${m} is marked DEGRADED so the outage is visible in telemetry`, d.degraded === true);
  ok(`${m} never retries (a retry cannot repair an absent measurement)`,
    decide({ measurement: m, distance: null, attemptsMade: 1 }).outcome === "accept");
  ok(`${m} says nothing to the user`, d.userMessage === "" && d.severity === "none");
}

// Multiple faces: open in general, closed on a duplicated subject.
ok("a bystander whose face does not match does NOT block a group scene",
  decide({ distance: 0.2, facesInOutput: 3, clearingFaces: 1 }).outcome === "accept");
const dup = decide({ distance: 0.2, facesInOutput: 2, clearingFaces: 2, bestSoFar: 0.2 });
ok("the subject rendered TWICE → fails CLOSED (retry)", dup.outcome === "retry");
ok("duplicate subject names its cause", dup.reason === "duplicate_subject_retrying");
ok("duplicate subject on the last attempt with no clean earlier take → reject",
  decide({
    distance: 0.2, facesInOutput: 2, clearingFaces: 2,
    attemptsMade: IDENTITY_MAX_ATTEMPTS, bestSoFar: null,
  }).outcome === "reject");
ok("two MARGINAL faces are not treated as a duplicate (lookalikes are not a bug)",
  decide({ distance: marginal, facesInOutput: 2, clearingFaces: 0, attemptsMade: 2, bestSoFar: marginal })
    .outcome === "accept");
ok("duplicate detection is switchable off for group-heavy packs",
  decideIdentityGate(
    obs({ distance: 0.2, facesInOutput: 2, clearingFaces: 2 }),
    identityGateConfig(cfg.metric, { rejectDuplicateSubject: false }),
  ).outcome === "accept");

// Background scenes: the gate must not exist.
const bg = decide({ subjectRequested: false, distance: null });
ok("a scene with no person requested is not gated", bg.reason === "gate_not_applicable");
ok("an ungated scene delivers", bg.outcome === "accept");
ok("an ungated scene is not marked degraded", bg.degraded === false);

// ---------------------------------------------------------------------------
// observeFaceDistances — the bridge from the face model's output.
// ---------------------------------------------------------------------------
ok("no detections → no_face_in_output",
  observeFaceDistances([], cfg).measurement === "no_face_in_output");
ok("null (the measurement layer failed) → measurement_failed, NOT a pass",
  observeFaceDistances(null, cfg).measurement === "measurement_failed");
ok("undefined → measurement_failed", observeFaceDistances(undefined, cfg).measurement === "measurement_failed");
ok("many faces → gate on the closest", observeFaceDistances([0.9, 0.31, 0.7], cfg).distance === 0.31);
ok("many faces → count them", observeFaceDistances([0.9, 0.31, 0.7], cfg).facesInOutput === 3);
ok("clearing faces counted against the confidence band",
  observeFaceDistances([0.2, 0.3, 0.9], cfg).clearingFaces === 2);
ok("a face exactly at the confidence band counts as clearing",
  observeFaceDistances([ACCEPT], cfg).clearingFaces === 1);
ok("background scenes short-circuit the observation",
  observeFaceDistances(null, cfg, { subjectRequested: false }).measurement === "ok");
throws("a nonsense distance from the model is caught at the boundary",
  () => observeFaceDistances([0.3, 12], cfg), "invalid_score");
throws("NaN from the model is caught at the boundary",
  () => observeFaceDistances([NaN], cfg), "invalid_score");
ok("observation → decision round-trips",
  decideIdentityGate(
    observeFaceDistances([0.2], cfg, { attemptsMade: 1, bestSoFar: null, elapsedMs: 0 }),
    cfg,
  ).reason === "identity_confirmed");

// ---------------------------------------------------------------------------
// The DB record. generation_identity_evaluations derives passed = distance <=
// threshold in SQL; an unverified generation must not write a distance at all.
// ---------------------------------------------------------------------------
const rec = identityEvaluationRecord(decide({ distance: 0.2 }));
ok("a verified delivery produces an evaluation row", rec !== null);
ok("the row is versioned by policy AND metric",
  rec.evaluator_version === `${IDENTITY_GATE_POLICY_VERSION}:${cfg.metric}`);
ok("the row's derived passed agrees with the SQL CHECK",
  rec.passed === (rec.distance <= rec.threshold));
ok("an unverified delivery writes NO row", identityEvaluationRecord(unenrolled) === null);
ok("a degraded delivery writes NO row",
  identityEvaluationRecord(decide({ measurement: "model_unavailable", distance: null })) === null);
ok("a rejection writes no distance row", identityEvaluationRecord(exhausted) === null);
ok("a marginal delivery at the gate still records as passed",
  identityEvaluationRecord(decide({ distance: REJECT, attemptsMade: IDENTITY_MAX_ATTEMPTS })).passed === true);

// ---------------------------------------------------------------------------
// Exhaustive invariant sweep. Everything above says what the gate does; this
// says what it can NEVER do, across the whole reachable state space.
// ---------------------------------------------------------------------------
const distances = [0, 0.1, ACCEPT - EPS, ACCEPT, ACCEPT + EPS, marginal,
  REJECT - EPS, REJECT, REJECT + EPS, 0.8, 1.2, cfg.maximum];
const bests = [null, 0, 0.3, ACCEPT, REJECT, REJECT + EPS, 1.4];
const elapsed = [0, cfg.deadlineMs - 1, cfg.deadlineMs, cfg.deadlineMs * 3];
let swept = 0;
let vDeliver = 0, vShown = 0, vQuota = 0, vRetry = 0, vTerminal = 0;
for (const measurement of IDENTITY_MEASUREMENTS) {
  for (const distance of measurement === "ok" ? distances : [null]) {
    for (const faces of [0, 1, 2, 4]) {
      for (const clearing of [0, 1, 2]) {
        if (clearing > faces) continue;
        for (let attemptsMade = 1; attemptsMade <= cfg.maxAttempts; attemptsMade += 1) {
          for (const bestSoFar of bests) {
            for (const elapsedMs of elapsed) {
              let d;
              try {
                d = decideIdentityGate({
                  measurement, distance, facesInOutput: faces, clearingFaces: clearing,
                  subjectRequested: true, attemptsMade, bestSoFar, elapsedMs,
                }, cfg);
              } catch (error) {
                if (error instanceof IdentityGateError) continue; // rejected input, not a state
                throw error;
              }
              swept += 1;

              // 1. Something is shown if and only if we accepted. Both a
              //    retry and a rejection show nothing; only a rejection is
              //    terminal-with-nothing.
              if ((d.deliver !== "none") !== (d.outcome === "accept")) vDeliver += 1;
              if (d.outcome === "reject" && d.deliver !== "none") vDeliver += 1;

              // 2. THE RULE. A verified image that is shown is always inside the
              //    hard gate. No path, no exhaustion, no deadline, no rescue may
              //    put a face past the threshold in front of a user.
              if (d.deliver !== "none" && d.verified && d.deliveredDistance !== null &&
                  d.deliveredDistance > cfg.reject) vShown += 1;

              // 3. Money. A retry costs the user nothing; a terminal outcome
              //    either consumes exactly one slot or releases it, never both,
              //    never neither.
              if (d.outcome === "retry") {
                if (d.consumesQuota || d.releaseQuota) vQuota += 1;
                if (d.deliver !== "none") vRetry += 1;
                // A retry is only ever issued with budget AND time remaining.
                if (d.attemptsRemaining <= 0 || elapsedMs >= cfg.deadlineMs) vRetry += 1;
              } else {
                if (d.consumesQuota === d.releaseQuota) vQuota += 1;
                if (d.outcome === "reject" && !d.releaseQuota) vTerminal += 1;
                if (d.outcome === "accept" && !d.consumesQuota) vTerminal += 1;
              }
            }
          }
        }
      }
    }
  }
}
ok(`invariant sweep ran over a real state space (${swept} states)`, swept > 3000, `${swept}`);
ok("INVARIANT 1: something is shown iff we accepted; a rejection shows nothing", vDeliver === 0, `${vDeliver} violations`);
ok("INVARIANT 2: a shown verified face is NEVER past the hard gate", vShown === 0, `${vShown} violations`);
ok("INVARIANT 3: a retry never touches the user's quota", vQuota === 0, `${vQuota} violations`);
ok("INVARIANT 4: a retry shows nothing and only issues with budget + time left",
  vRetry === 0, `${vRetry} violations`);
ok("INVARIANT 5: every rejection releases, every acceptance consumes",
  vTerminal === 0, `${vTerminal} violations`);

// The sweep must actually reach a rejection, or it is proving nothing.
ok("the sweep reaches every outcome",
  ["accept", "retry", "reject"].every((o) =>
    distances.some((distance) =>
      [1, cfg.maxAttempts].some((attemptsMade) =>
        bests.some((bestSoFar) =>
          decideIdentityGate({
            measurement: "ok", distance, facesInOutput: 1, clearingFaces: 0,
            subjectRequested: true, attemptsMade, bestSoFar, elapsedMs: 0,
          }, cfg).outcome === o)))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
