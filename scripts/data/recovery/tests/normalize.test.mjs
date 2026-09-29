import { test } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeQuestionType, normalizeDifficulty, normalizeSubject, normalizeClassLevel, normalizeExam,
    normalizeTaxonomyName, normalizeQbgIdValue, normalizeParentId, normalizeLink, normalizeAnswer,
    normalizeOptions, normalizeRichText, dedupeKey, taxonomyCompareKey,
} from "../lib/normalize.mjs";
import { normalizeQbgId, classifyValue, extractDriveId, normalizeQuestionNumber } from "../lib/ids.mjs";

test("QBG id: valid, trimmed, invalid; never rewritten", () => {
    assert.equal(normalizeQbgId("m17hp8zu9zyc74xcrxpwia4kt").valid, true);
    const t = normalizeQbgId(" m17hp8zu9zyc74xcrxpwia4kt ");
    assert.deepEqual([t.valid, t.value, t.reason], [true, "m17hp8zu9zyc74xcrxpwia4kt", "TRIMMED_WHITESPACE"]);
    const up = normalizeQbgId("M17HP8ZU9ZYC74XCRXPWIA4KT");
    assert.equal(up.valid, false);
    assert.equal(up.value, "M17HP8ZU9ZYC74XCRXPWIA4KT"); // not lower-cased
    assert.equal(normalizeQbgId("Paper-02").valid, false);
    assert.equal(normalizeQbgIdValue("Paper-02").status, "UNRESOLVED");
    assert.equal(normalizeQbgIdValue(null).status, "EMPTY");
});

test("identifier classification keeps systems apart", () => {
    assert.equal(classifyValue("iydv16vvyph4i0hajzqbqxk2t"), "QBG_CUID25");
    assert.equal(classifyValue("6f1c2a7e-9b1d-5c3e-8a4f-2d7b9e0c1a55"), "UUID");
    assert.equal(classifyValue("TC-PHY-001"), "TC_ID");
    assert.equal(classifyValue("PA-PHY-012"), "PA_ID");
    assert.equal(classifyValue("Q038"), "QUESTION_NUMBER");
    assert.equal(extractDriveId("https://drive.google.com/open?id=1C6Bv26g-jcrIs-fW5ggoe14E-bUwiqTC&usp=drive_copy"), "1C6Bv26g-jcrIs-fW5ggoe14E-bUwiqTC");
    assert.equal(extractDriveId("https://drive.google.com/file/d/1WhDGv791KvIdVZ15dPMZ0lQ2-R1Q6fkX/view"), "1WhDGv791KvIdVZ15dPMZ0lQ2-R1Q6fkX");
    assert.equal(normalizeQuestionNumber("Q038"), 38);
    assert.equal(normalizeQuestionNumber(76), 76);
    assert.equal(normalizeQuestionNumber("Done"), null);
});

test("question type aliases and typos", () => {
    assert.equal(normalizeQuestionType("SCQ").normalized_value, "Single_Choice(SCQ)");
    assert.equal(normalizeQuestionType("Numerial").normalization_rule, "TYPO_NUMERIAL");
    assert.equal(normalizeQuestionType("Int").normalized_value, "Integer");
    assert.equal(normalizeQuestionType("single Digit").normalized_value, "Single_Digit_Integer");
    assert.equal(normalizeQuestionType("Para_Num1").normalized_value, "Passage_Numerical");
    assert.equal(normalizeQuestionType("Para2").normalized_value, "Comprehension(COMP)");
    assert.equal(normalizeQuestionType("List Type").status, "UNRESOLVED");
    assert.equal(normalizeQuestionType("Single_Choice(SCQ)").normalization_rule, "IDENTITY");
});

test("difficulty, subject, class, exam", () => {
    assert.equal(normalizeDifficulty(3).normalized_value, "Hard");
    assert.equal(normalizeDifficulty("Difficult").confidence, "medium");
    assert.equal(normalizeDifficulty("0").status, "EMPTY");
    assert.equal(normalizeSubject("Mathethatics").normalization_rule, "TYPO_MATHEMATICS");
    assert.equal(normalizeSubject("Mathematics").normalized_value, "Maths");
    assert.equal(normalizeSubject("physics").normalization_rule, "CASE");
    assert.equal(normalizeSubject("PCM").status, "UNRESOLVED");
    assert.equal(normalizeClassLevel(11).normalized_value, "11");
    assert.equal(normalizeClassLevel("11th").normalized_value, "11");
    assert.equal(normalizeClassLevel("AITS_Test-01_Arjuna_JEE_29-10-2023_Solution.pdf").normalization_rule, "NOT_A_CLASS_DOCUMENT_REF");
    assert.deepEqual(normalizeExam("Advance_P2").normalized_value, { exam: "JEE Advanced", paper: 2 });
    assert.deepEqual(normalizeExam("Mains").normalized_value, { exam: "JEE Main", paper: null });
    assert.equal(normalizeExam("2022_P1").normalized_value.exam, null);
});

test("taxonomy names", () => {
    assert.equal(normalizeTaxonomyName("[Biomolecules]").normalized_value, "Biomolecules");
    assert.equal(normalizeTaxonomyName("  Motion  in a Plane ").normalized_value, "Motion in a Plane");
    assert.equal(normalizeTaxonomyName("-").status, "EMPTY");
    assert.equal(normalizeTaxonomyName("a5ddoll4mwx9vp6ksx15y8oqh").normalization_rule, "ID_IN_NAME_COLUMN");
    assert.equal(taxonomyCompareKey("Moving Charges & Magnetism"), taxonomyCompareKey("moving charges and magnetism"));
});

test("parent id accepts QBG and UUID, rejects other", () => {
    assert.equal(normalizeParentId("x7h5mc9d6p8uswmt2zlvlaln5").normalization_rule, "QBG_CUID25");
    assert.equal(normalizeParentId("6F1C2A7E-9B1D-5C3E-8A4F-2D7B9E0C1A55").normalized_value, "6f1c2a7e-9b1d-5c3e-8a4f-2d7b9e0c1a55");
    assert.equal(normalizeParentId("abc").status, "UNRESOLVED");
});

test("links", () => {
    const q = normalizeLink("https://qbg-admin.penpencil.co/question-details?question=oz1r86hmc4tvgvox1nfjc5muz");
    assert.deepEqual([q.normalized_value.kind, q.normalized_value.id], ["QBG_QUESTION_PAGE", "oz1r86hmc4tvgvox1nfjc5muz"]);
    const d = normalizeLink("-https://qbg-admin.penpencil.co/question-details?question=oz1r86hmc4tvgvox1nfjc5muz");
    assert.match(d.normalization_rule, /STRIP_LEADING_DASH/);
    assert.equal(normalizeLink("https://drive.google.com/open?id=1C6Bv26g-jcrIs-fW5ggoe14E-bUwiqTC&amp;usp=drive_copy").normalized_value.id, "1C6Bv26g-jcrIs-fW5ggoe14E-bUwiqTC");
    assert.equal(normalizeLink("https://drive.google.com/drive/folders/1jI5qPV_j9zuzWw6JulCa_C3NHBeYtTwL?usp=drive_link").normalized_value.kind, "DRIVE_FOLDER");
    assert.equal(normalizeLink("https://docs.google.com/spreadsheets/d/1xe_rV1AeiJJ5P5ddtJXmVlIWRsLibiJ5tGV2q0zYxYE/edit").normalized_value.kind, "GOOGLE_SHEET");
    assert.equal(normalizeLink("Link").status, "UNRESOLVED");
});

test("answer: SCQ / MCQ / integer / numerical string / ambiguous", () => {
    assert.deepEqual(normalizeAnswer("3", "Single_Choice(SCQ)").normalized_value, [3]);
    assert.deepEqual(normalizeAnswer(3, "Single_Choice(SCQ)").normalized_value, [3]);
    assert.deepEqual(normalizeAnswer("1,3", "Multi_Choice(MCQ)").normalized_value, [1, 3]);
    assert.deepEqual(normalizeAnswer("B", "Single_Choice(SCQ)").normalized_value, [2]);
    assert.equal(normalizeAnswer("243", "Integer").normalized_value, 243);
    assert.equal(normalizeAnswer("2.43", "Numerical").normalized_value, "2.43");
    assert.equal(normalizeAnswer("64.00", "Numerical").normalized_value, "64.00"); // not rounded to 64
    assert.equal(normalizeAnswer(1.5, "Numerical").normalized_value, "1.5");
    assert.equal(normalizeAnswer("4.00", "Integer").confidence, "medium");
    assert.equal(normalizeAnswer("0", "Single_Choice(SCQ)").status, "UNRESOLVED");
    assert.equal(normalizeAnswer("5", "Single_Choice(SCQ)").normalization_rule, "OPTION_INDEX_OUT_OF_RANGE");
    assert.equal(normalizeAnswer("1,2", "Single_Choice(SCQ)").normalization_rule, "MULTIPLE_ANSWERS_FOR_SINGLE_CORRECT_TYPE");
    assert.equal(normalizeAnswer("3", "Comprehension(COMP)").status, "UNRESOLVED");
    assert.equal(normalizeAnswer(null, "Numerical").status, "EMPTY");
    // numerical answers are never turned into option indexes
    assert.equal(typeof normalizeAnswer("3", "Numerical").normalized_value, "number");
    assert.equal(Array.isArray(normalizeAnswer("3", "Numerical").normalized_value), false);
});

test("options: labels only are never content", () => {
    const l = normalizeOptions("A~B~C~D");
    assert.equal(l.options_status, "OPTION_LABELS_ONLY");
    assert.equal(l.normalized_value, null);
    assert.equal(normalizeOptions("Select and submit to view solution").options_status, "PLACEHOLDER_TEXT");
    const t = normalizeOptions(["a", "b", "c", "d"], [2]);
    assert.deepEqual(t.normalized_value.map((o) => o.isCorrect), [false, true, false, false]);
    assert.equal(normalizeOptions(["a", "", "c"]).status, "UNRESOLVED");
    assert.equal(normalizeOptions(null, null, "Numerical").options_status, "NOT_APPLICABLE");
});

test("rich text keeps markup; dedupe key strips it", () => {
    const html = "<p>Find  x<sup>2</sup> &amp; <img src='a.png'></p>";
    assert.equal(normalizeRichText(html).normalized_value, "<p>Find x<sup>2</sup> &amp; <img src='a.png'></p>");
    assert.equal(dedupeKey(html), "find x 2 img");
    assert.equal(dedupeKey("Find X², ok!"), dedupeKey("find x2 ok").replace("x2", "x2")); // NFKC folds ²
});

test("normalisation is deterministic", () => {
    const inputs = ["SCQ", " Mathematics ", "[Biomolecules]", "1,3", "https://drive.google.com/open?id=1C6Bv26g-jcrIs-fW5ggoe14E-bUwiqTC"];
    const run = () => JSON.stringify([normalizeQuestionType(inputs[0]), normalizeSubject(inputs[1]), normalizeTaxonomyName(inputs[2]), normalizeAnswer(inputs[3], "Multi_Choice(MCQ)"), normalizeLink(inputs[4])]);
    assert.equal(run(), run());
});
