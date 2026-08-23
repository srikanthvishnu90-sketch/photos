/**
 * @typedef {"female" | "male" | "unspecified" | null} GenderValue
 * @typedef {"Under 18" | "18–21" | "22–29" | "30+" | null} AgeRange
 * @typedef {Object} OnboardingState
 * @property {string} name
 * @property {GenderValue} gender
 * @property {AgeRange} ageRange
 * @property {string[]} aesthetics
 */

/**
 * @param {OnboardingState} state
 * @returns {Promise<{ok: true}>}
 */
export async function submitOnboarding(state) {
  // TODO: submit the onboarding profile to the production API.
  console.info("TODO: Submit onboarding", state);
  return { ok: true };
}

/**
 * @param {string} rawText
 * @param {GenderValue} gender
 * @param {AgeRange} ageRange
 * @param {string[]} currentSelections
 */
export function logCustomAesthetic(rawText, gender, ageRange, currentSelections) {
  // TODO: send this structured first-party taste event to analytics.
  console.info("TODO: Log custom aesthetic", {
    rawText,
    gender,
    ageRange,
    currentSelections,
  });
}
