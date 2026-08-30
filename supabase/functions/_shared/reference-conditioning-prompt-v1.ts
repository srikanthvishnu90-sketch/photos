export const REFERENCE_CONDITIONING_PROMPT_VERSION =
  "reference-conditioning-v1" as const;

export interface ConditioningPromptReference {
  selectionRank: number;
  gradeNotes: string;
  description: string;
}

function cleanText(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

export function buildReferenceConditioningInstruction(
  references: readonly ConditioningPromptReference[],
): string {
  if (references.length !== 3) {
    throw new Error("reference_conditioning_requires_exactly_three_images");
  }
  const ordered = [...references].sort(
    (left, right) => left.selectionRank - right.selectionRank,
  );
  if (ordered.some((reference, index) => reference.selectionRank !== index + 1)) {
    throw new Error("reference_conditioning_ranks_are_invalid");
  }

  const gradeNotes = ordered.map((reference, index) => {
    const grade = cleanText(reference.gradeNotes, 500);
    const look = cleanText(reference.description, 500);
    if (!grade || !look) throw new Error("reference_conditioning_metadata_missing");
    return `Reference ${index + 1}: look — ${look}; grade — ${grade}.`;
  });

  return [
    `REFERENCE CONDITIONING POLICY (${REFERENCE_CONDITIONING_PROMPT_VERSION}):`,
    "The three images marked REFERENCE ROLE — PHOTOGRAPHIC CHARACTER are visual-language references only.",
    "Match the photographic character of the reference images — their light quality, color grade, framing habits, texture, and level of everyday imperfection.",
    "Do NOT copy their composition, subjects, people, landmarks, logos, text, clothing, or specific objects. Create a genuinely new scene in the requested setting, in the same broad visual language.",
    "Never merge reference subjects into the output. Identity may come only from images explicitly marked REFERENCE ROLE — IDENTITY.",
    "GRADE NOTES:",
    ...gradeNotes,
  ].join("\n");
}
