/**
 * QBG (PenPencil) category label -> category_configuration_id.
 *
 * Single source of truth for the client: QBG Modification, QBG Ingestion and the
 * QBG Pipeline all push questions into one of these categories, and each used to
 * carry its own private copy of this table — so adding a category meant three
 * identical edits and any miss left one tool silently short of an option.
 *
 * MIRROR: python/qbg_modification/qbg.py's CATEGORIES holds the same mapping for
 * the sidecar (a separate runtime — it cannot import this file). Add a category
 * in BOTH places, and note that AI tagging additionally needs taxonomy rows for
 * the category in python/qbg_modification/tagging_data/qbg_tagging_table.csv —
 * see tagmatch.category_label_for.
 */
export const QBG_CATEGORIES: Record<string, string> = {
    "NEET-JEE": "vckzned6mqjlkub8wsfh605rp",
    JEE: "cx68ito6el81m1ec6eqv43x5u",
    Foundation: "lx10i0wrdv7mvy95slphkhow7",
    NEET: "1l81g6ggobyxxgllarkcjg5vj",
    Boards: "sttwbg8nyyicizp9b47194mpf",
    "Real Test": "rb9u45ap0rqyi7ll9lj59ijtw",
    "RankUp Test Series": "viz514z85nacy6sl0xylkipit",
};

/** Dropdown order — the object's own insertion order. */
export const QBG_CATEGORY_NAMES = Object.keys(QBG_CATEGORIES);

/** The label a category id belongs to, or null when it isn't one of ours. */
export function qbgCategoryLabel(id: string): string | null {
    for (const [label, cid] of Object.entries(QBG_CATEGORIES)) {
        if (cid === id) return label;
    }
    return null;
}
