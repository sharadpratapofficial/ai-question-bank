/**
 * Registry of the raw sources the recovery pipeline knows about.
 *
 * `candidates` are tried in order (repo-relative). A source whose files are all
 * absent is recorded as MISSING in the inventory and every downstream stage
 * treats it as UNAVAILABLE; nothing is substituted for it.
 *
 * RankUp material (PYQ registers, concept/archetype registers, book cards,
 * rankup_chem_bank.csv) was not found in this repository. To bring it in, copy
 * the files into data/raw/rankup/ (read-only inputs) and re-run the pipeline.
 */
export const SOURCES = [
    {
        key: "autocuration",
        category: "QBG_METADATA",
        label: "AutoCuration_Lovee.xlsx",
        candidates: ["AutoCuration_Lovee.xlsx", "AutoCuration_Lovee (1).xlsx", "data/raw/AutoCuration_Lovee.xlsx"],
        purpose: "QBG id -> taxonomy codes/names, question type, difficulty, answer, source-document file names",
    },
    {
        key: "important_ids",
        category: "QBG_TEST_MAPPING",
        label: "Important IDs Replica.xlsx",
        candidates: ["Important IDs Replica.xlsx", "Important IDs REplica (1).xlsx", "Important IDs REplica.xlsx", "data/raw/Important IDs Replica.xlsx"],
        purpose: "QBG id -> test/exam occurrence (test series, paper, question number)",
    },
    {
        key: "tagging_csv",
        category: "QBG_TAGGING",
        label: "qbg_tagging_table.csv",
        candidates: ["python/qbg_modification/tagging_data/qbg_tagging_table.csv"],
        purpose: "QBG taxonomy (category/class/subject/chapter/topic/subtopic names + ids); no question content",
    },
    {
        key: "aits_t03_question_docx",
        category: "SOURCE_DOCUMENT",
        label: "AITS_Test-03_12th_JEE_15-12-2024_Question.docx",
        candidates: ["AITS_Test-03_12th_JEE_15-12-2024_Question.docx"],
        purpose: "Question paper for AITS Test-03 (12th JEE Main, 15-12-2024)",
    },
    {
        key: "aits_t03_solution_docx",
        category: "SOURCE_DOCUMENT",
        label: "AITS_Test-03_12th_JEE_15-12-2024_Solutions.docx",
        candidates: ["AITS_Test-03_12th_JEE_15-12-2024_Solutions.docx"],
        purpose: "Answer key + solutions for AITS Test-03 (12th JEE Main, 15-12-2024)",
    },
    {
        key: "jrts_modifier_sample_docx",
        category: "SOURCE_DOCUMENT",
        label: "qbg modifier sample file.docx",
        candidates: ["qbg modifier sample file.docx"],
        purpose: "JRTS JEE Main (Dropper) Test-01 maths section sample (app test fixture); no QBG ids inside",
    },
    {
        key: "batch_test_docx",
        category: "SOURCE_DOCUMENT",
        label: "Batch_Test-word (2).docx",
        candidates: ["Batch_Test-word (2).docx"],
        purpose: "App-generated 'Batch Test' export sample; no QBG ids inside",
    },
    // ---- RankUp generation knowledge (expected by the brief; not present locally) ----
    { key: "rankup_chem_bank", category: "RANKUP_GENERATED", label: "rankup_chem_bank.csv", candidates: ["rankup_chem_bank.csv", "data/raw/rankup/rankup_chem_bank.csv"], purpose: "RankUp generated chemistry questions" },
    { key: "pyq_register_sbc_atm_per_rdx", category: "PYQ_REGISTER", label: "PYQ_Register_SBC_ATM_PER_RDX.md", candidates: ["data/raw/rankup/PYQ_Register_SBC_ATM_PER_RDX.md"], purpose: "PYQ register: Some Basic Concepts / Structure of Atom / Periodicity / Redox (brief: 556 PYQs)" },
    { key: "pyq_register_ec", category: "PYQ_REGISTER", label: "EC_PYQ_Register.md", candidates: ["data/raw/rankup/EC_PYQ_Register.md"], purpose: "PYQ register: Electrochemistry (brief: 213 PYQs)" },
    { key: "textbook_concept_register", category: "TEXTBOOK_CONCEPT", label: "Textbook_Concept_Register.md", candidates: ["data/raw/rankup/Textbook_Concept_Register.md"], purpose: "Textbook concepts TC-*-### (brief: 331)" },
    { key: "problem_archetype_register", category: "ARCHETYPE", label: "Problem_Archetype_Register.md", candidates: ["data/raw/rankup/Problem_Archetype_Register.md"], purpose: "Problem archetypes PA-*-### (brief: 124)" },
    { key: "reference_library_book_cards", category: "REFERENCE_LIBRARY", label: "Reference_Library_Book_Cards.md", candidates: ["data/raw/rankup/Reference_Library_Book_Cards.md"], purpose: "Reference book cards (brief: 27 books)" },
    { key: "book_concept_guide", category: "REFERENCE_LIBRARY", label: "Book_Concept_Guide.md", candidates: ["data/raw/rankup/Book_Concept_Guide.md"], purpose: "Book concept guide" },
    { key: "chemistry_source_library", category: "REFERENCE_LIBRARY", label: "Chemistry_Source_Library.md", candidates: ["data/raw/rankup/Chemistry_Source_Library.md"], purpose: "Chemistry source library" },
    { key: "extensive_source_compilation", category: "REFERENCE_LIBRARY", label: "Extensive_Source_Compilation.md", candidates: ["data/raw/rankup/Extensive_Source_Compilation.md"], purpose: "Extensive source compilation" },
];

/** Directory scanned for any additional RankUp files (e.g. more PYQ registers). */
export const RANKUP_DROP_DIR = "data/raw/rankup";
