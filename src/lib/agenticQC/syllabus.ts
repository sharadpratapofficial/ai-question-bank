/**
 * Curated standard syllabus chapter lists for the "Full Syllabus Class 11"
 * and "Full Syllabus Class 12" checkboxes in Agentic QC.
 *
 * These are the canonical chapter names used by JEE Main / NEET / CBSE NCERT
 * (which are ≥95% aligned for the core science subjects). They feed the
 * `syllabusText` field in the QC config, which the agents use to decide
 * whether each question falls within the expected syllabus.
 *
 * Sources cross-referenced: NTA JEE Main syllabus (2024), NTA NEET syllabus,
 * NCERT class 11/12 textbook tables of contents. We keep the wording short
 * to keep the prompt token-economical.
 */

export type ExamFamily = "JEE_MAINS" | "JEE_ADVANCED" | "NEET" | "CUSTOM";

interface SyllabusBundle {
    Physics?: string[];
    Chemistry?: string[];
    Mathematics?: string[];
    Biology?: string[];
    Botany?: string[];
    Zoology?: string[];
}

// ─── NCERT Biology chapter lists (Class 11 & 12) ────────────────────────
// Sourced from the NCERT Class 11/12 Biology textbook tables of contents and
// the standard NEET Botany/Zoology split used by major coaching institutes.
// `Biology` is the full combined list; `Botany` / `Zoology` are the
// plant-side / animal-side halves for papers that separate the two.
const BIO_11_BOTANY = [
    "The Living World",
    "Biological Classification",
    "Plant Kingdom",
    "Morphology of Flowering Plants",
    "Anatomy of Flowering Plants",
    "Cell: The Unit of Life",
    "Biomolecules",
    "Cell Cycle and Cell Division",
    "Photosynthesis in Higher Plants",
    "Respiration in Plants",
    "Plant Growth and Development",
];
const BIO_11_ZOOLOGY = [
    "Animal Kingdom",
    "Structural Organisation in Animals",
    "Breathing and Exchange of Gases",
    "Body Fluids and Circulation",
    "Excretory Products and their Elimination",
    "Locomotion and Movement",
    "Neural Control and Coordination",
    "Chemical Coordination and Integration",
];
const BIO_12_BOTANY = [
    "Sexual Reproduction in Flowering Plants",
    "Principles of Inheritance and Variation",
    "Molecular Basis of Inheritance",
    "Microbes in Human Welfare",
    "Biotechnology: Principles and Processes",
    "Biotechnology and its Applications",
    "Organisms and Populations",
    "Ecosystem",
    "Biodiversity and Conservation",
];
const BIO_12_ZOOLOGY = [
    "Human Reproduction",
    "Reproductive Health",
    "Evolution",
    "Human Health and Disease",
];

/** Class 11 — common across JEE / NEET / CBSE. */
const CLASS_11: Record<"JEE" | "NEET", SyllabusBundle> = {
    JEE: {
        Physics: [
            "Physics and Measurement",
            "Kinematics",
            "Laws of Motion",
            "Work Energy and Power",
            "Rotational Motion",
            "Gravitation",
            "Properties of Solids and Liquids",
            "Thermodynamics",
            "Kinetic Theory of Gases",
            "Oscillations and Waves",
        ],
        Chemistry: [
            "Some Basic Concepts in Chemistry",
            "Atomic Structure",
            "Chemical Bonding and Molecular Structure",
            "Chemical Thermodynamics",
            "Solutions",
            "Equilibrium",
            "Redox Reactions",
            "Classification of Elements and Periodicity",
            "Hydrogen",
            "s-Block Elements",
            "p-Block Elements (Group 13 and 14)",
            "Organic Chemistry — Basic Principles",
            "Hydrocarbons",
            "Environmental Chemistry",
        ],
        Mathematics: [
            "Sets, Relations and Functions",
            "Complex Numbers and Quadratic Equations",
            "Matrices and Determinants",
            "Permutations and Combinations",
            "Mathematical Induction",
            "Binomial Theorem",
            "Sequences and Series",
            "Trigonometry",
            "Straight Lines",
            "Conic Sections",
            "Three Dimensional Geometry (intro)",
            "Limits and Derivatives",
            "Statistics",
            "Probability",
        ],
    },
    NEET: {
        Physics: [
            "Physical World and Measurement",
            "Kinematics",
            "Laws of Motion",
            "Work, Energy and Power",
            "Motion of System of Particles and Rigid Body",
            "Gravitation",
            "Properties of Bulk Matter",
            "Thermodynamics",
            "Behaviour of Perfect Gas and Kinetic Theory",
            "Oscillations and Waves",
        ],
        Chemistry: [
            "Some Basic Concepts of Chemistry",
            "Structure of Atom",
            "Classification of Elements and Periodicity",
            "Chemical Bonding and Molecular Structure",
            "States of Matter",
            "Thermodynamics",
            "Equilibrium",
            "Redox Reactions",
            "Hydrogen",
            "s-Block Elements",
            "Some p-Block Elements",
            "Organic Chemistry: Basic Principles",
            "Hydrocarbons",
            "Environmental Chemistry",
        ],
        Biology: [...BIO_11_BOTANY, ...BIO_11_ZOOLOGY],
        Botany: BIO_11_BOTANY,
        Zoology: BIO_11_ZOOLOGY,
    },
};

/** Class 12 — common across JEE / NEET / CBSE. */
const CLASS_12: Record<"JEE" | "NEET", SyllabusBundle> = {
    JEE: {
        Physics: [
            "Electrostatics",
            "Current Electricity",
            "Magnetic Effects of Current and Magnetism",
            "Electromagnetic Induction and Alternating Currents",
            "Electromagnetic Waves",
            "Optics (Ray and Wave)",
            "Dual Nature of Matter and Radiation",
            "Atoms and Nuclei",
            "Electronic Devices",
            "Communication Systems",
        ],
        Chemistry: [
            "Solid State",
            "Solutions",
            "Electrochemistry",
            "Chemical Kinetics",
            "Surface Chemistry",
            "General Principles and Processes of Isolation of Metals",
            "p-Block Elements (Group 15, 16, 17, 18)",
            "d- and f- Block Elements",
            "Coordination Compounds",
            "Haloalkanes and Haloarenes",
            "Alcohols, Phenols and Ethers",
            "Aldehydes, Ketones and Carboxylic Acids",
            "Organic Compounds Containing Nitrogen",
            "Biomolecules",
            "Polymers",
            "Chemistry in Everyday Life",
        ],
        Mathematics: [
            "Relations and Functions",
            "Inverse Trigonometric Functions",
            "Matrices",
            "Determinants",
            "Continuity and Differentiability",
            "Applications of Derivatives",
            "Integrals",
            "Applications of Integrals",
            "Differential Equations",
            "Vector Algebra",
            "Three Dimensional Geometry",
            "Linear Programming",
            "Probability",
        ],
    },
    NEET: {
        Physics: [
            "Electrostatics",
            "Current Electricity",
            "Magnetic Effects of Current and Magnetism",
            "Electromagnetic Induction and Alternating Currents",
            "Electromagnetic Waves",
            "Optics",
            "Dual Nature of Matter and Radiation",
            "Atoms and Nuclei",
            "Electronic Devices",
        ],
        Chemistry: [
            "Solid State",
            "Solutions",
            "Electrochemistry",
            "Chemical Kinetics",
            "Surface Chemistry",
            "General Principles and Processes of Isolation of Elements",
            "p-Block Elements",
            "d- and f- Block Elements",
            "Coordination Compounds",
            "Haloalkanes and Haloarenes",
            "Alcohols, Phenols and Ethers",
            "Aldehydes, Ketones and Carboxylic Acids",
            "Organic Compounds Containing Nitrogen",
            "Biomolecules",
            "Polymers",
            "Chemistry in Everyday Life",
        ],
        Biology: [...BIO_12_BOTANY, ...BIO_12_ZOOLOGY],
        Botany: BIO_12_BOTANY,
        Zoology: BIO_12_ZOOLOGY,
    },
};

/**
 * Get the merged "full syllabus" for the chosen exam + class set.
 * `classes` may include 11, 12, or both.
 */
export function fullSyllabusFor(
    examType: ExamFamily,
    classes: Array<11 | 12>
): SyllabusBundle {
    const key: "JEE" | "NEET" = examType === "NEET" ? "NEET" : "JEE";
    const out: SyllabusBundle = {};
    const merge = (bundle: SyllabusBundle) => {
        for (const [subj, chs] of Object.entries(bundle)) {
            if (!chs) continue;
            const k = subj as keyof SyllabusBundle;
            out[k] = [...(out[k] || []), ...chs];
        }
    };
    if (classes.includes(11)) merge(CLASS_11[key]);
    if (classes.includes(12)) merge(CLASS_12[key]);
    // Deduplicate while preserving order.
    for (const k of Object.keys(out) as (keyof SyllabusBundle)[]) {
        const seen = new Set<string>();
        out[k] = (out[k] || []).filter((c) => {
            const lower = c.toLowerCase();
            if (seen.has(lower)) return false;
            seen.add(lower);
            return true;
        });
    }
    return out;
}

/**
 * Render a SyllabusBundle to the text format the page's syllabus textarea
 * already uses: "Physics: ch1, ch2; Chemistry: ch1, ch2; …"
 */
export function syllabusToText(bundle: Record<string, string[] | undefined>): string {
    const parts: string[] = [];
    for (const [subj, chs] of Object.entries(bundle)) {
        if (!chs || chs.length === 0) continue;
        parts.push(`${subj}: ${chs.join(", ")}`);
    }
    return parts.join(";\n");
}
