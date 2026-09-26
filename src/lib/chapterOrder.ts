const PHYSICS_CHAPTER_SEQUENCE = [
    "Mathematical Tools and Vectors",
    "Units and Measurements",
    "Motion in a Straight Line",
    "Motion in a Plane",
    "Laws of Motion",
    "Work Energy and Power",
    "Circular Motion",
    "Center of Mass and System of Particles",
    "Rotational Motion",
    "Gravitation",
    "Mechanical Properties of Solids",
    "Mechanical Properties of Fluids",
    "Thermal Properties of Matter",
    "Kinetic Theory",
    "Thermodynamics",
    "Oscillations",
    "Waves",
    "Electric Charges and Fields",
    "Electrostatic Potential and Capacitance",
    "Current Electricity",
    "Moving Charges and Magnetism",
    "Magnetism and Matter",
    "Electromagnetic Induction",
    "Alternating Current",
    "Electromagnetic Waves",
    "Ray Optics and Optical Instruments",
    "Wave Optics",
    "Dual Nature of Radiation and Matter",
    "Atoms",
    "Nuclei",
    "Semiconductor Electronics: Materials, Devices and Simple Circuits",
    "Communication Systems",
    "Experimental Physics",
] as const;

const CHEMISTRY_CHAPTER_SEQUENCE = [
    "Some Basic Concepts of Chemistry",
    "Structure of Atom",
    "Classification of Elements and Periodicity in Properties",
    "Chemical Bonding and Molecular Structure",
    "States of Matter",
    "Thermodynamics",
    "Equilibrium",
    "Chemical Equilibrium",
    "Ionic Equilibrium",
    "Redox Reactions",
    "Hydrogen",
    "The s-Block Elements",
    "The p-Block Elements",
    "Organic Chemistry: Some Basic Principles and Techniques",
    "Hydrocarbons",
    "Environmental Chemistry",
    "Solutions",
    "Electrochemistry",
    "Chemical Kinetics",
    "Surface Chemistry",
    "General Principles and Processes of Isolation of Elements",
    "The p-Block Elements (XII)",
    "The d and f-Block Elements",
    "Coordination Compounds",
    "Haloalkanes and Haloarenes",
    "Alcohols, Phenols and Ethers",
    "Aldehydes, Ketones and Carboxylic Acids",
    "Amines",
    "Biomolecules",
    "Polymers",
    "Chemistry in Everyday Life",
    "Principles of Qualitative Analysis",
    "Principles related to Practical Chemistry",
] as const;

const MATHS_CHAPTER_SEQUENCE = [
    "Basic Maths",
    "Sets",
    "Trigonometric Functions",
    "Complex Numbers and Quadratic Equations",
    "Quadratic Equations",
    "Linear Inequalities",
    "Permutations and Combinations",
    "Binomial Theorem",
    "Sequence and Series",
    "Straight Lines",
    "Circles",
    "Conic Section",
    "Introduction to Three Dimensional Geometry",
    "Limits and Derivatives",
    "Statistics",
    "Relations and Functions",
    "Inverse Trigonometric Functions",
    "Matrices",
    "Determinants",
    "Continuity and Differentiability",
    "Application of Derivatives",
    "Indefinite Integration",
    "Definite Integration",
    "Application of Integrals",
    "Differential Equations",
    "Probability",
    "Vector Algebra",
    "Three Dimensional Geometry",
    "Principle of Mathematical Induction",
] as const;

export const SUBJECT_CHAPTER_SEQUENCE: Record<string, readonly string[]> = {
    Physics: PHYSICS_CHAPTER_SEQUENCE,
    Chemistry: CHEMISTRY_CHAPTER_SEQUENCE,
    Maths: MATHS_CHAPTER_SEQUENCE,
};

/**
 * Match a chapter to its place in the book sequence regardless of how it is
 * spelled in the data.
 *
 * `trim().toLowerCase()` was too strict: "Work, Energy and Power" and
 * "Work Energy and Power" are the same chapter but differ by a comma, so one of
 * them fell out of the configured order and got alphabetised to the end. Same
 * for "The p-Block Elements" vs "The P-Block Elements". Punctuation is dropped,
 * "&" is read as "and", and filler words are ignored, so any of those spellings
 * lands on the same sequence entry.
 */
export function chapterKey(value: string): string {
    return (value || "")
        // Escape sequences that survived into the data as literal TEXT (a backslash
        // followed by n/r/t) become spaces first. Without this the backslash is
        // dropped and its "n" glues to the next word: the chapter stored as
        // "Semiconductor Electronics:\nMaterials, Devices and Simple Circuits"
        // normalised to "...electronics nmaterials devices..." and so never matched
        // its clean twin — the chapter showed up twice in every picker and the admin
        // merge tool never offered to join them (2026-08-31 bug report). Real control
        // characters need no special case: the [^a-z0-9] pass below folds them away.
        .replace(/\\+[nrt]/g, " ")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((w) => w && !["and", "the", "of", "with", "a", "an"].includes(w))
        .join(" ")
        .trim();
}


function normalize(value: string): string {
    return chapterKey(value);
}

export function compareChaptersBySubject(
    subject: string,
    a: string,
    b: string
): number {
    const sequence = SUBJECT_CHAPTER_SEQUENCE[subject];
    if (!sequence || sequence.length === 0) {
        return a.localeCompare(b);
    }

    const orderMap = new Map(
        sequence.map((chapter, idx) => [normalize(chapter), idx])
    );

    const ai = orderMap.get(normalize(a));
    const bi = orderMap.get(normalize(b));

    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.localeCompare(b);
}

export function sortChaptersForSubject(
    subject: string,
    chapters: string[]
): string[] {
    const sequence = SUBJECT_CHAPTER_SEQUENCE[subject];
    const unique = [...new Set(chapters)];

    if (!sequence || sequence.length === 0) {
        return unique.sort((a, b) => a.localeCompare(b));
    }

    const presentByNormalized = new Map<string, string>();
    unique.forEach((chapter) => {
        presentByNormalized.set(normalize(chapter), chapter);
    });

    const ordered: string[] = [];
    sequence.forEach((chapter) => {
        const existing = presentByNormalized.get(normalize(chapter));
        if (existing) {
            ordered.push(existing);
            presentByNormalized.delete(normalize(chapter));
            return;
        }
        // Include configured chapters even if currently absent in DB rows.
        ordered.push(chapter);
    });

    const remaining = [...presentByNormalized.values()].sort((a, b) =>
        a.localeCompare(b)
    );

    return [...ordered, ...remaining];
}
