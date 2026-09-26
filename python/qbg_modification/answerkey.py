# -*- coding: utf-8 -*-
"""
Spread the answer key across the options.

The problem
-----------
A reframed paper's key piles up on option (A). That is not chance: a model asked
to write four options and mark the correct one tends to write the correct one
FIRST and the distractors after it, so (A) ends up correct far more often than
a quarter of the time — and often for several questions in a row (2026-09-09
report). A student who notices can score without reading the paper, which makes
it an unfair paper rather than an untidy one.

The fix
-------
Permute the OPTIONS inside each question and carry the correct flag with them.
Option order in a multiple-choice question is arbitrary — nothing about the
physics changes when "16 W" is printed third instead of first — so this is the
one repair that costs nothing: no question is rewritten, no answer is changed,
only where the right answer sits.

Two targets, in this order of importance:

  1. no two consecutive questions share the correct letter;
  2. each letter is correct about as often as any other.

How much each question is allowed to move
-----------------------------------------
Not every option set may be shuffled, but the ones that may not are not all
equally stuck, so there are three tiers rather than two (2026-09-12: a paper
made entirely of numeric ladders came out with TEN consecutive (A)s because the
old code had only "shuffle" and "leave alone", and a ladder fell in the second):

  * FREE — order carries no meaning; permute at will.
  * MIRROR — options are a numeric ladder (2 W, 4 W, 8 W, 16 W). The ladder is
    a convention a student reads as information, so the options may not be
    shuffled — but a DESCENDING ladder is exactly as conventional as an
    ascending one, so the whole list may be reversed. That keeps the convention
    and still moves the key, from position i to position k-1-i. A
    distractors-by-scaling model ("16 W" correct, then 32, 64, 128) produces
    precisely this shape, answer first, which is why it matters.
  * FIXED — the options cannot move at all: Assertion-Reason and Matching-List
    wording QBG never varies, options that name other options ("Both (A) and
    (C)", "None of these"), multi-correct keys with no single letter to place,
    and numericals with no options.

A FIXED question still occupies its slot: its letter is what its neighbours are
planned around, and it counts towards each letter's quota, so a paper heavy in
Assertion-Reason does not get its (A)s double-counted.

Solved, not guessed
-------------------
The letters are chosen by a short dynamic program over the paper rather than a
left-to-right greedy pass, because the only interaction is between neighbours
and greedy cannot see one question ahead: a ladder boxed between a pinned (A)
and a spent mirror has nowhere to go. The solver returns the fewest matching
neighbours any legal choice of letters can produce (checked against brute force
on 3000 random chains), so a run it cannot break is one no reordering could.

Nothing is assumed to have worked
---------------------------------
The final key is measured again after the plan is applied, and any surviving run
is reported, named by question number, so it reaches the run's warnings and the
UI instead of a student.
"""
import re

from logsetup import get_logger

log = get_logger("answerkey")

_LET = "ABCDEF"

# A run this long or longer is called out by name in the warnings. Two in a row
# is worth recording in the report; three is the "many consecutive questions"
# a student starts to notice.
_LOUD_RUN = 3

# Mobility tiers, most mobile first. See the module docstring.
FREE = "free"
MIRROR = "mirror"
FIXED = "fixed"

# "Both (A) and (C)", "(A) and (B)" — an option that refers to another by letter
# cannot move, and neither can the ones it names.
_SELF_REF = re.compile(r"\(\s*[A-Fa-f]\s*\)|\b(?:both|all|none|any)\b\s+(?:of\s+)?(?:the\s+)?"
                       r"(?:above|these|them|options)", re.I)
# The leading number of an option, for the ordered-by-magnitude test.
_LEAD_NUM = re.compile(r"-?\d+(?:\.\d+)?")


def _option_text(opt):
    """Plain text of one option, whatever shape it is in."""
    if isinstance(opt, dict):
        return "[image]" if opt.get("img") else ""
    out = []
    for p in opt or []:
        if isinstance(p, dict):
            if "t" in p:
                out.append(str(p["t"]))
            elif "m" in p:
                out.append(str(p["m"]))
            elif "img" in p:
                out.append("[image]")
    return " ".join(out).strip()


def _lead_number(text):
    m = _LEAD_NUM.search(text or "")
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def _is_ordered_by_magnitude(texts):
    """True when the options read as a sorted numeric ladder.

    Only a set where EVERY option leads with a number counts, and only when the
    sequence is strictly monotonic — two or three numbers that happen to ascend
    are a coincidence, four in order are a convention.
    """
    nums = [_lead_number(t) for t in texts]
    if len(nums) < 3 or any(n is None for n in nums):
        return False
    ascending = all(nums[i] < nums[i + 1] for i in range(len(nums) - 1))
    descending = all(nums[i] > nums[i + 1] for i in range(len(nums) - 1))
    return ascending or descending


def _answer_letter(ans):
    """The single correct letter, or None when there isn't exactly one."""
    if isinstance(ans, (list, tuple)):
        letters = [str(a).strip().upper() for a in ans if str(a).strip()]
        return letters[0] if len(letters) == 1 else None
    s = str(ans or "").strip().upper()
    return s if len(s) == 1 and s in _LET else None


def _mirror_letter(letter, k):
    """The letter at the mirrored position — where the key lands if the ladder is reversed."""
    i = _LET.find(letter or "")
    if i < 0 or k <= 0 or i >= k:
        return None
    return _LET[k - 1 - i]


def eligibility(q):
    """(tier, reason) — how far may this question's options move?

    The reason is filled in only when the tier is not FREE, because it is what
    the report shows against a question that was not fully shuffled.
    """
    qtype = (q.get("type") or "SCQ").upper()
    if qtype in ("NUMERICAL", "INTEGER", "SINGLE_DIGIT_INTEGER"):
        return FIXED, "numerical — no options"
    if qtype in ("ASSERTION_REASON", "MATCHING_LIST"):
        return FIXED, "%s — its options are fixed" % qtype.replace("_", " ").title()
    opts = q.get("options") or []
    if len(opts) < 2:
        return FIXED, "fewer than two options"
    letter = _answer_letter(q.get("answer"))
    if not letter:
        return FIXED, "multi-correct — no single letter to place"
    if _LET.find(letter) >= len(opts):
        return FIXED, "the key names an option that does not exist"
    texts = [_option_text(o) for o in opts]
    # Checked before the ladder test: an option naming another one pins the whole
    # set, and reversing it would move "None of these" off the end.
    if any(_SELF_REF.search(t or "") for t in texts):
        return FIXED, "an option refers to the others by letter"
    if _is_ordered_by_magnitude(texts):
        if _mirror_letter(letter, len(opts)) == letter:
            # Odd option count with the key dead centre — reversing changes nothing.
            return FIXED, "options are ordered by magnitude, key sits at the mirror point"
        return MIRROR, "options are ordered by magnitude — ladder reversed instead of shuffled"
    return FREE, ""


def _candidates(tier, current, k):
    """The letters this question's key could be placed on, given its tier."""
    if tier == FREE:
        return list(_LET[:k])
    if tier == MIRROR:
        mirrored = _mirror_letter(current, k)
        return [c for c in (current, mirrored) if c]
    return [current] if current else []


def _solve_sequence(candidates):
    """Pick one letter per question so that as few neighbours as possible match.

    Solved rather than guessed. Greedy left-to-right planning cannot see a trap
    one question ahead: a ladder has only two legal positions for its key, so a
    ladder sitting next to a pinned (A) must take its mirror — but a greedy pass
    that has already spent the mirror on the question BEFORE it has nothing left
    and emits the repeat (2026-09-12: 80 breakable runs in 400 randomised
    papers). Since the only interaction is between neighbours, the exact optimum
    is a short dynamic program over the chain, and it costs nothing at this size.

    `candidates` is one list of allowed letters per question, in paper order; an
    entry of [None] is a question with no single letter (a numerical, a
    multi-correct), which breaks a run rather than extending it.

    Returns the chosen letters. Among all solutions with the fewest matching
    neighbours, it prefers the letter used least so far, which is what keeps the
    distribution even.
    """
    n = len(candidates)
    if n == 0:
        return []
    # tail[i][c] = fewest matching neighbour pairs over questions i..n-1, given
    # that question i takes letter c.
    tail = [{} for _ in range(n)]
    for c in candidates[n - 1]:
        tail[n - 1][c] = 0
    for i in range(n - 2, -1, -1):
        for c in candidates[i]:
            tail[i][c] = min(tail[i + 1][nxt] + (1 if c is not None and c == nxt else 0)
                             for nxt in candidates[i + 1])

    chosen = []
    used = {}
    prev = None
    for i in range(n):
        # tail is exact, so taking the best (step + tail) at every step walks an
        # optimal solution; the rest of the key is the tie-break.
        ranked = sorted(
            candidates[i],
            key=lambda c: ((1 if c is not None and c == prev else 0) + tail[i][c],
                           used.get(c, 0), c or ""),
        )
        pick = ranked[0]
        if pick is not None:
            used[pick] = used.get(pick, 0) + 1
        chosen.append(pick)
        prev = pick
    return chosen


def _plan_letters(items, tier_of, letter_of, n_letters_of):
    """Choose a target letter for every question that can take one.

    A FIXED question is never planned, but it still enters the solve as a
    single-candidate question so its neighbours are placed around it, and it
    still spends quota — otherwise a paper full of pinned (A)s would keep being
    handed more (A)s.
    """
    candidates = []
    for num in items:
        tier = tier_of[num]
        current = letter_of.get(num)
        if tier == FIXED:
            candidates.append([current])
        else:
            candidates.append(_candidates(tier, current, n_letters_of[num]) or [current])

    chosen = _solve_sequence(candidates)
    return {num: letter for num, letter, tier in zip(items, chosen, (tier_of[n] for n in items))
            if tier != FIXED and letter}


def _move_option(opts, from_idx, to_idx):
    """Move one option to a new position, keeping the others in order.

    A move rather than a swap: swapping scrambles the two positions, while
    lifting the correct option out and re-inserting it leaves the distractors in
    the order the author wrote them.
    """
    out = list(opts)
    item = out.pop(from_idx)
    out.insert(to_idx, item)
    return out


def distribution(questions):
    """How many times each letter is correct (single-correct questions only)."""
    counts = {}
    for q in questions:
        letter = _answer_letter(q.get("answer"))
        if letter and (q.get("options") or []):
            counts[letter] = counts.get(letter, 0) + 1
    return counts


def runs(questions, min_len=2):
    """Every stretch of consecutive questions sharing a correct letter.

    A question with no single letter (a numerical, a multi-correct) breaks the
    stretch rather than extending it — a student flipping through the paper sees
    it break too.
    """
    found = []
    start = 0
    prev = None
    for i, q in enumerate(list(questions) + [None]):
        letter = _answer_letter(q.get("answer")) if q is not None else None
        if letter is not None and letter == prev:
            continue
        if prev is not None and i - start >= min_len:
            found.append({
                "letter": prev,
                "length": i - start,
                "nums": [questions[j].get("num", j + 1) for j in range(start, i)],
            })
        start = i
        prev = letter
    return found


def longest_run(questions):
    """The longest stretch of consecutive questions sharing a correct letter."""
    found = runs(questions, min_len=1)
    return max((r["length"] for r in found), default=0)


def balance_answer_key(questions):
    """Permute options so the key is spread. Returns (questions, report)."""
    nums = [q.get("num", i) for i, q in enumerate(questions, 1)]
    tier_of = {}
    letter_of = {}
    n_letters_of = {}
    skipped = []
    for num, q in zip(nums, questions):
        tier, reason = eligibility(q)
        tier_of[num] = tier
        letter_of[num] = _answer_letter(q.get("answer"))
        n_letters_of[num] = len(q.get("options") or [])
        if tier != FREE:
            skipped.append({"num": num, "reason": reason, "tier": tier})

    before_counts = distribution(questions)
    before_run = longest_run(questions)
    plan = _plan_letters(nums, tier_of, letter_of, n_letters_of)

    out = []
    moved = []
    for num, q in zip(nums, questions):
        target = plan.get(num)
        current = letter_of.get(num)
        if not target or not current or target == current:
            out.append(q)
            continue
        q = dict(q)
        k = n_letters_of[num]
        if tier_of[num] == MIRROR:
            # The ladder flips as a whole: ascending becomes descending, which is
            # the same convention read the other way, and the key lands at k-1-i.
            q["options"] = list(reversed(q["options"]))
        else:
            from_idx = _LET.find(current)
            to_idx = _LET.find(target)
            if from_idx < 0 or to_idx < 0 or to_idx >= k:
                out.append(q)
                continue
            q["options"] = _move_option(q["options"], from_idx, to_idx)
        q["answer"] = target
        moved.append({"num": num, "from": current, "to": target, "tier": tier_of[num]})
        out.append(q)

    after_counts = distribution(out)
    after_run = longest_run(out)
    # Measure again rather than trust the plan. A run can only survive when every
    # question in it was FIXED, but that is exactly the case worth naming.
    residual = []
    for r in runs(out, min_len=2):
        tiers = sorted({tier_of.get(n) for n in r["nums"] if tier_of.get(n)})
        residual.append({
            "letter": r["letter"],
            "length": r["length"],
            "nums": r["nums"],
            # The solver returns the fewest matching neighbours any legal choice
            # of letters can produce, so a run that survives it is one no
            # reordering could have broken — it needs a content change. A run
            # with a FREE question in it would contradict that, so it is called
            # out separately rather than quietly reported as forced.
            "unavoidable": FREE not in tiers,
            "tiers": tiers,
        })

    report = {
        "moved": moved,
        "skipped": skipped,
        "before": {"counts": before_counts, "longest_run": before_run},
        "after": {"counts": after_counts, "longest_run": after_run},
        "residual_runs": residual,
    }
    log.info("answer key: moved %d of %d, %s -> %s, longest run %d -> %d, %d residual run(s)",
             len(moved), len(questions), before_counts, after_counts,
             before_run, after_run, len(residual))
    for r in residual:
        log.warning("answer key: %d consecutive questions still answer (%s): %s — %s",
                    r["length"], r["letter"],
                    ", ".join("Q%s" % n for n in r["nums"]),
                    "their options cannot move far enough to break it (%s)" % ", ".join(r["tiers"])
                    if r["unavoidable"] else
                    "UNEXPECTED: a freely shuffleable question is in this run")
    return out, report


def summarize(report):
    """One sentence for the run's warnings, or None when nothing needed doing."""
    if not report:
        return None
    before = report["before"]["counts"]
    after = report["after"]["counts"]
    moved = len(report["moved"])
    residual = report.get("residual_runs") or []
    loud = [r for r in residual if r["length"] >= _LOUD_RUN]

    fmt = lambda c: ", ".join("%s×%d" % (k, c[k]) for k in sorted(c))
    lines = []
    if moved:
        lines.append("Answer key rebalanced: %d question(s) had their options reordered so the correct "
                     "answer moved. Was %s (longest run %d), now %s (longest run %d)."
                     % (moved, fmt(before) or "-", report["before"]["longest_run"],
                        fmt(after) or "-", report["after"]["longest_run"]))
    if loud:
        worst = max(loud, key=lambda r: r["length"])
        lines.append("Answer key WARNING: %d question(s) in a row still answer (%s) — %s. "
                     "Their options cannot be reordered far enough to break the run "
                     "(fixed wording, an option naming another, or a ladder whose key sits "
                     "at its mirror point), so this needs a content change, not a reshuffle."
                     % (worst["length"], worst["letter"],
                        ", ".join("Q%s" % n for n in worst["nums"])))
    return " ".join(lines) if lines else None
