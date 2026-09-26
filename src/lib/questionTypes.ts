const PASSAGE_PARENT_TYPES = new Set(["composite", "passage_numerical"]);

function normalizeQuestionType(type: string | null | undefined): string {
    return (type || "").trim().toLowerCase();
}

export function isPassageParentQuestionType(
    type: string | null | undefined
): boolean {
    return PASSAGE_PARENT_TYPES.has(normalizeQuestionType(type));
}
