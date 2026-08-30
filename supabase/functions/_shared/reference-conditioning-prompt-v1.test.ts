import { buildReferenceConditioningInstruction } from "./reference-conditioning-prompt-v1.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("conditioning instruction preserves anti-copy language and rank order", () => {
  const prompt = buildReferenceConditioningInstruction([
    {
      selectionRank: 2,
      description: "handheld night street photo",
      gradeNotes: "cool highlights, dense neutral blacks",
    },
    {
      selectionRank: 1,
      description: "casual rooftop frame at blue hour",
      gradeNotes: "restrained saturation and fine phone noise",
    },
    {
      selectionRank: 3,
      description: "wide skyline photograph",
      gradeNotes: "soft practical light and imperfect framing",
    },
  ]);

  assert(
    prompt.includes("Do NOT copy their composition"),
    "anti-copy instruction must be explicit",
  );
  assert(
    prompt.includes("Identity may come only from images explicitly marked"),
    "identity boundary must be explicit",
  );
  assert(
    prompt.indexOf("casual rooftop") < prompt.indexOf("handheld night"),
    "metadata must follow retrieval rank rather than input order",
  );
});

Deno.test("conditioning instruction rejects incomplete sets", () => {
  let threw = false;
  try {
    buildReferenceConditioningInstruction([]);
  } catch {
    threw = true;
  }
  assert(threw, "conditioning must fail closed without exactly three refs");
});
