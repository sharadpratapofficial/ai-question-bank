# -*- coding: utf-8 -*-
"""Extract original questions/answers/solutions + diagrams from a .docx, and build the
reframing prompt. Uses pandoc (via pypandoc) to recover equations as MathML and images."""
import os, re, base64, shutil, tempfile
import pypandoc
from PIL import Image
from logsetup import get_logger

log = get_logger("extract")

def _txt(b):
    t=re.sub(r'<annotation[^>]*>.*?</annotation>','',b,flags=re.S)
    t=re.sub(r'<[^>]+>',' ',t); t=re.sub(r'&[a-zA-Z]+;',' ',t)
    return re.sub(r'\s+',' ',t).strip()

def _save_png(src_path, dst_path):
    Image.open(src_path).convert('RGB').save(dst_path,'PNG')

def extract(docx_path, workdir):
    """Returns dict: source_name, questions[list], originals{N:(html,ans,sol)}, figdir, prompt."""
    log.info("extract start: %s (%d bytes)", docx_path,
              os.path.getsize(docx_path) if os.path.exists(docx_path) else -1)
    source_name=os.path.splitext(os.path.basename(docx_path))[0]
    media=os.path.join(workdir,'media'); os.makedirs(media,exist_ok=True)
    figdir=os.path.join(workdir,'figures'); os.makedirs(figdir,exist_ok=True)
    html=pypandoc.convert_file(docx_path,'html',format='docx',
        extra_args=['--mathml','--extract-media='+media])
    blocks=re.findall(r'<(?:p|table|ol|ul)\b.*?</(?:p|table|ol|ul)>', html, re.S)
    txt=[_txt(b) for b in blocks]; n=len(blocks)

    ans_idx=[i for i,t in enumerate(txt) if re.match(r'^\d+\.\s*\([A-D]\)\s*$', t)]
    if not ans_idx:
        raise ValueError("Could not find an answer key (lines like '1. (B)'). Is this the expected format?")
    ans_start=min(ans_idx)
    qstarts=sorted(i for i,t in enumerate(txt) if i<ans_start and re.match(r'^\d+\.(\s|$)', t))
    answers={}
    for i in ans_idx:
        m=re.match(r'^(\d+)\.\s*\(([A-D])\)', txt[i]); answers[int(m.group(1))]=m.group(2)
    sol_starts=sorted(i for i,t in enumerate(txt) if 'Text Solution' in t)
    sol_bounds=sol_starts+[n]

    # media data-uri map for compare panel
    def media_datauri(fn):
        for root,_,files in os.walk(media):
            if fn in files:
                p=os.path.join(root,fn)
                ext=os.path.splitext(fn)[1].lower().lstrip('.')
                mime='image/png' if ext=='png' else ('image/jpeg' if ext in('jpg','jpeg') else 'image/'+ext)
                with open(p,'rb') as f: return 'data:%s;base64,%s'%(mime,base64.b64encode(f.read()).decode())
        return None
    def media_path(fn):
        for root,_,files in os.walk(media):
            if fn in files: return os.path.join(root,fn)
        return None
    def embed(block):
        b=re.sub(r'src="([^"]*media/[^"]+)"',
                 lambda m:'src="%s"'%(media_datauri(os.path.basename(m.group(1))) or m.group(1)), block)
        return re.sub(r'<annotation[^>]*>.*?</annotation>','',b,flags=re.S)

    # solutions html (compare) by number; also save any solution figures to figdir
    sols={}; sol_imgs={}
    for k,si in enumerate(sol_starts):
        N=int(re.match(r'^(\d+)\.',txt[si]).group(1)); seg=[]; imgs=[]
        for j in range(si, sol_bounds[k+1]):
            if txt[j].startswith('Video Solution'): continue
            if '<img' in blocks[j] and txt[j]=='': continue
            for src in re.findall(r'src="([^"]+)"', blocks[j]):
                mp=media_path(os.path.basename(src))
                if mp:
                    nm='q%d_sol%d.png'%(N,len(imgs)+1)
                    _save_png(mp, os.path.join(figdir,nm)); imgs.append(nm)
            seg.append(embed(blocks[j]))
        sols[N]=''.join(seg); sol_imgs[N]=imgs

    questions=[]; originals={}
    for qi in range(len(qstarts)):
        N=qi+1
        start=qstarts[qi]; end=qstarts[qi+1] if qi+1<len(qstarts) else ans_start
        qb=list(range(start,end))
        # original html (compare): non-empty or image blocks
        oseg=[embed(blocks[j]) for j in qb if txt[j]!='' or '<img' in blocks[j]]
        originals[N]=(''.join(oseg), answers.get(N,''), sols.get(N,''))
        # figure detection
        def imgs_in(j):
            return re.findall(r'src="([^"]+)"', blocks[j])
        fig_name=None
        stem_imgs=imgs_in(qb[0]) if qb else []
        if stem_imgs:
            src=os.path.basename(stem_imgs[0]); mp=media_path(src)
            if mp:
                fig_name='q%d_figure.png'%N; _save_png(mp, os.path.join(figdir,fig_name))
        # option images: image blocks after the stem
        opt_imgs=[]
        for j in qb[1:]:
            ii=imgs_in(j)
            if ii: opt_imgs.append(os.path.basename(ii[0]))
        opt_img_names=None
        if len(opt_imgs)>=2:   # treat as image options
            opt_img_names=[]
            for idx,src in enumerate(opt_imgs[:4]):
                mp=media_path(src)
                nm='q%d_opt%s.png'%(N,'ABCD'[idx])
                if mp: _save_png(mp, os.path.join(figdir,nm))
                opt_img_names.append(nm)
        # text of stem and options
        q_text=re.sub(r'^\d+\.\s*','',txt[qb[0]])
        opt_texts=[]; opt_html=[]
        for j in qb[1:]:
            t=txt[j]
            if re.match(r'^\([A-D]\)', t):
                opt_texts.append(t)
                oh=embed(blocks[j])
                oh=re.sub(r'\(\s*[A-D]\s*\)\s*','',oh,count=1)   # drop the "(A)" label
                opt_html.append(oh)
        if not opt_html and opt_img_names:                        # image options
            for src in opt_imgs[:4]:
                du=media_datauri(src)
                if du: opt_html.append('<p><img src="%s" /></p>'%du)
        # stem-only html: blocks before the first option (text or image option), number stripped.
        opt_text_js=[j for j in qb[1:] if re.match(r'^\([A-D]\)', txt[j])]
        img_opt_js=[j for j in qb[1:] if imgs_in(j)]
        cand=([min(opt_text_js)] if opt_text_js else [])+([min(img_opt_js)] if len(img_opt_js)>=2 else [])
        first_opt_j=min(cand) if cand else None
        stem_js=[j for j in qb if (first_opt_j is None or j<first_opt_j) and (txt[j]!='' or '<img' in blocks[j])]
        stem_html=''.join(embed(blocks[j]) for j in stem_js)   # leading "N." stripped in qbg
        # No option text and no option images -> this is a Numerical/integer-answer
        # question in the source docx (there's no explicit "type" field to read here,
        # unlike the QBG-fetched path — presence/absence of options is the only signal).
        q_type = 'NUMERICAL' if not (opt_texts or opt_img_names) else 'SCQ'
        questions.append({'num':N,'q_text':q_text,'options_text':opt_texts,'options_html':opt_html,'stem_html':stem_html,
            'answer':answers.get(N,''),'sol_text':_txt(re.sub(r'^\d+\.\s*Text Solution:?','', txt[sol_starts[qi]] if qi<len(sol_starts) else '')) or (sols.get(N,'') and _txt(sols[N])),
            'fig_name':fig_name,'opt_img_names':opt_img_names,'sol_img_names':sol_imgs.get(N,[]),'type':q_type})
    prompt=build_prompt(source_name, questions)
    nfig=sum(1 for q in questions if q['fig_name'])
    log.info("extract ok: source=%s questions=%d figures=%d", source_name, len(questions), nfig)
    return {'source_name':source_name,'questions':questions,'originals':originals,
            'figdir':figdir,'prompt':prompt}

MODES = ("paraphrase", "vary_numbers", "full_rewrite")

# Difficulty is a SEPARATE axis from `mode`: mode says how much of the question may change,
# difficulty says how hard the result should be. "auto" keeps each mode's own built-in
# difficulty (exactly the behaviour before this option existed).
DIFFICULTY_LEVELS = ("auto", "harder", "much_harder")

def _syllabus_rule(syllabus):
    """The hard constraint that keeps a reframed question teachable.

    A test pooled from "Motion in a Plane" must not come back asking about force:
    Laws of Motion is a LATER chapter, so the student has not been taught it
    (2026-08-31 bug report — a Mathematical Tools / Units paper produced a Centre
    of Mass question). Two lists per subject:

      chapters   what the question must actually be ABOUT — its primary concept
      permitted  those plus every EARLIER chapter in the book, which the question
                 may lean on freely (a Rotation question may use Laws of Motion)
    """
    if not syllabus:
        return ""
    lines = [
        "SYLLABUS — THIS IS A HARD CONSTRAINT, IT OVERRIDES EVERY OTHER INSTRUCTION:",
        "This paper is for students who have been taught ONLY the chapters listed below. A "
        "question that needs anything beyond them is unusable no matter how good it is.",
    ]
    for entry in syllabus:
        subject = (entry.get("subject") or "").strip() or "This subject"
        chapters = [c for c in (entry.get("chapters") or []) if c]
        permitted = [c for c in (entry.get("permitted") or []) if c]
        if not chapters:
            continue
        lines.append("")
        lines.append("%s — the question's PRIMARY concept MUST come from one of these chapters:" % subject)
        lines.append("  " + "; ".join(chapters))
        extra = [c for c in permitted if c not in chapters]
        if extra:
            lines.append("%s — you MAY additionally use ideas from these EARLIER chapters as "
                         "supporting steps, but they must never be what the question is about:" % subject)
            lines.append("  " + "; ".join(extra))
        else:
            lines.append("%s — there are NO earlier chapters available: everything the question "
                         "needs must come from the chapters listed above alone." % subject)
    lines += [
        "",
        "Concretely: do NOT introduce any quantity, law or technique that is first taught in a "
        "chapter outside the lists above. If the original question already sits inside the "
        "syllabus, keep it there. If reframing it would require going outside, reframe it in a "
        "different direction that stays inside instead — never widen the syllabus to suit a "
        "question you would rather write.",
    ]
    return "\n".join(lines)


def _paper_style_rule(no_calculator=False, conceptual=False):
    """Paper-wide requirements the pipeline can switch on (QbgPipelinePanel).

    NO CALCULATOR: students sit JEE/NEET-style papers without one, so a question
    whose method is right but whose arithmetic needs 3.7 x 9.81 / 0.46 is testing
    the wrong thing and costs a student minutes they should spend thinking.
    MOSTLY CONCEPTUAL: understanding over arithmetic — the hard part should be
    seeing which idea applies, not carrying it out.

    Both override a mode's instruction to keep the original's numbers: an original
    with ugly numbers cannot satisfy "no calculator" without changing them.
    """
    parts = []
    if no_calculator:
        parts.append(
            "NO CALCULATOR — THIS PAPER IS SOLVED BY HAND, SO THIS IS A HARD CONSTRAINT: every question "
            "must be solvable with pen and paper in a few short lines of arithmetic. Choose the given values "
            "so they CANCEL or combine cleanly: small integers, simple fractions, g = 10 m/s^2, standard "
            "angles (30, 37, 45, 53, 60 degrees with sin 37 = 3/5), perfect squares and cubes under roots, "
            "and pi or sqrt(2)/sqrt(3) left symbolic or cancelling. Do NOT require multiplying or dividing "
            "multi-digit numbers with awkward results, logarithms or exponentials of arbitrary numbers, "
            "roots of non-perfect numbers, trigonometric values of non-standard angles, or long decimal "
            "arithmetic. The final answer must be clean — an integer, a simple fraction, or a simple "
            "multiple of a surd or pi — and so must every option. Before writing each question, do its "
            "arithmetic by hand yourself: if any step would make a student reach for a calculator, change "
            "the numbers until it would not. Where the reframing mode says to keep the original's numbers, "
            "this rule wins: change them."
        )
    if conceptual:
        parts.append(
            "MOSTLY CONCEPTUAL — THIS PAPER TESTS UNDERSTANDING, NOT ARITHMETIC: most of the questions you "
            "write must be conceptual. Two kinds count: (1) theory questions — which statement is correct, "
            "what happens to one quantity when another changes, ranking or comparing quantities, choosing "
            "the right graph or relationship, a limiting or special case; and (2) numericals with LIGHT "
            "arithmetic where the difficulty is in the approach — the right law or formula is not handed to "
            "the student by the wording, they have to recognise which concept applies, and often combine "
            "two ideas (from the permitted syllabus) before a short calculation. Avoid plug-and-chug "
            "questions that name the formula or give exactly its inputs. Keep each question's tagged type: "
            "a conceptual NUMERICAL still needs a whole-number answer, and a conceptual SCQ/MCQ uses "
            "conceptual options (statements, ratios, expressions, qualitative outcomes). Where the "
            "reframing mode says to keep the original's numbers or asked quantity, this rule wins."
        )
    return "\n\n".join(parts)


def build_prompt(source_name, questions, fig_urls=None, allow_diagram_changes=False, mode="full_rewrite",
                 gen_solution_diagrams=False, difficulty="auto", force_redraw=False, add_figures=False,
                 syllabus=None, no_calculator=False, conceptual=False):
    """fig_urls: optional {figdir filename: public URL}, for when the figures/option-images
    have been uploaded somewhere the assisted model can open (see app.py Assisted-mode section).
    allow_diagram_changes: when True, the model may also change what a figure shows (and must
    describe the change in "fig_edit" so app.py can regenerate the diagram); default keeps the
    original diagram untouched, as before.
    mode: "paraphrase" (same numbers, reword only), "vary_numbers" (new numbers, same physical
    quantity asked, same difficulty), or "full_rewrite" (default — today's existing behavior:
    full freedom including which quantity is asked, slightly harder).
    gen_solution_diagrams: when True, the model may set "sol_diagram_desc" on a question whose
    SOLUTION genuinely needs its own diagram to follow (separate from the question's own "fig") —
    see the sol_diagram_rule below for the strict "only when truly needed" gating.
    difficulty: "auto" (each mode's own built-in difficulty), "harder", or "much_harder" — an
    explicit difficulty override applied on top of the mode.
    force_redraw: with allow_diagram_changes, makes "fig_edit" MANDATORY on every question that has
    a figure, so the diagram is always redrawn to match the reframed numbers instead of the original
    image silently surviving while still showing the ORIGINAL question's values.
    add_figures: when True, the model may set "new_fig_desc" on a question that has NO figure but
    would be clearer with one, so cli.py can draw it (see _gen_new_figures)."""
    fig_urls=fig_urls or {}
    if mode not in MODES:
        mode = "full_rewrite"
    fig_rule = (
        "If a question has a figure (marked \"figure available: ...\" below), your reframed version of "
        "that question MUST ALSO keep a figure: set \"fig\" to that SAME exact filename. Never set "
        "\"fig\" to null just because you reworded the question — the diagram stays even if the wording "
        "around it changes. You MUST keep the data you write in the stem/options consistent with what "
        "the figure actually shows (you cannot silently change what the figure shows here). EXCEPTION: "
        "this rule does NOT apply to a [type: MATCHING_LIST] question — see the Matching_List-specific "
        "instructions below for how to handle its figure instead (always \"fig\": null for that type)."
    ) if not allow_diagram_changes else (
        "If a question has a figure (marked \"figure available: ...\" below), your reframed version of "
        "that question MUST ALSO keep a figure: set \"fig\" to that SAME exact filename. Never set "
        "\"fig\" to null just because you reworded the question — dropping the diagram is not allowed. "
        "You MAY change the values/configuration the figure shows (e.g. a resistor's value, a distance, "
        "an angle) as long as the new diagram would still make physical sense — but only when you do, "
        "fill \"fig_edit\" with a precise, self-contained instruction for an image-editing AI that will "
        "redraw it FROM the original diagram. That instruction MUST be a surgical edit description, not "
        "a general redraw: (1) name the EXACT original text/value and where it sits in the figure (e.g. "
        "\"the '5 Ω' label on the resistor, upper-left of the circuit\"), (2) give the EXACT new "
        "text/value to put there, (3) explicitly say every other label, arrow and shape must stay in its "
        "exact original position and style. If the figure's data is unchanged, set \"fig_edit\" to null. "
        "EXCEPTION: this rule does NOT apply to a [type: MATCHING_LIST] question — see the "
        "Matching_List-specific instructions below for how to handle its figure instead (always "
        "\"fig\": null for that type)."
    )
    if allow_diagram_changes and force_redraw:
        fig_rule = (
            "If a question has a figure (marked \"figure available: ...\" below), your reframed version of "
            "that question MUST ALSO keep a figure: set \"fig\" to that SAME exact filename. Never set "
            "\"fig\" to null just because you reworded the question \u2014 dropping the diagram is not "
            "allowed. Every one of these diagrams WILL be redrawn, so \"fig_edit\" is MANDATORY: for EVERY "
            "question that has a figure you MUST fill \"fig_edit\" with a precise, self-contained "
            "instruction for an image-editing AI that redraws it FROM the original diagram \u2014 never "
            "write \"fig_edit\": null for a question that has a figure. That instruction MUST (1) name each "
            "EXACT original text/value and where it sits in the figure (e.g. \"the '5 \u03a9' label on the "
            "resistor, upper-left of the circuit\"), (2) give the EXACT new text/value to put there so the "
            "diagram matches the numbers you wrote in your reframed stem/options \u2014 a figure still "
            "carrying the ORIGINAL question's values would make your question wrong or unsolvable, and (3) "
            "explicitly say every other label, arrow and shape must stay in its exact original position and "
            "style. If some value in the figure genuinely does not change, still name it and state that it "
            "must stay exactly as it is: your instruction has to account for the whole figure, and must "
            "never be null. EXCEPTION: this rule does NOT apply to a [type: MATCHING_LIST] question \u2014 "
            "see the Matching_List-specific instructions below for how to handle its figure instead (always "
            "\"fig\": null for that type)."
        )
    sol_diagram_rule = (
        " For each question, also decide whether its SOLUTION needs its own small diagram (separate "
        "from the question's own \"fig\") to be understood — set \"sol_diagram_desc\" to a precise "
        "description of that diagram, or null. Use this RARELY, only when the solution sets up a "
        "spatial/geometric configuration that is genuinely hard to follow in words alone (e.g. the "
        "levels/columns inside a U-tube or manometer, a ray diagram for a lens/mirror construction, a "
        "circuit redrawn at an intermediate step, vector components resolved along new axes). Do NOT "
        "request one for routine cases where the solution's own equations already make the setup clear "
        "(e.g. plain force/free-body-diagram problems, kinematics, standard circuit analysis, basic "
        "energy/momentum conservation) — most solutions should have \"sol_diagram_desc\": null. When you "
        "do write a description, it must be precise and self-contained (labels, values, geometry) so an "
        "image-generation AI can draw it with ZERO errors — wrong labels or a wrong configuration would "
        "be worse than no diagram at all."
    ) if gen_solution_diagrams else ""
    new_fig_rule = (
        " Separately, for a question that has NO figure at all (no \"figure available:\" marker below), "
        "decide whether your reframed version would be genuinely clearer WITH one \u2014 set "
        "\"new_fig_desc\" to a precise description of the diagram to draw, or null. Use it only where a "
        "diagram carries real information the words cannot: a labelled circuit, a geometry/ray/vector "
        "construction, a pulley/incline/spring arrangement, a labelled graph. Do NOT request one as "
        "decoration for a question already fully specified in words (plain kinematics or algebraic "
        "problems, definitions, direct formula substitution) \u2014 those keep \"new_fig_desc\": null. "
        "When you do write one it must be complete and self-contained (every label, every value, the exact "
        "layout) and must agree EXACTLY with the numbers in your stem, since a diagram that contradicts the "
        "stem is far worse than no diagram. Never set \"new_fig_desc\" on a question that already has a "
        "figure (use \"fig\"/\"fig_edit\" for those), and never on a [type: MATCHING_LIST] question."
    ) if add_figures else ""
    type_rule = (
        "Every question below is tagged [type: SCQ], [type: MCQ], [type: NUMERICAL], "
        "[type: MATCHING_LIST], or [type: ASSERTION_REASON]. You MUST preserve that exact type in your "
        "output for every question — never turn one type into another. "
        "For [type: SCQ]: \"options\" MUST have exactly 4 entries, exactly ONE is correct, and "
        "\"answer\" is that option's letter as a plain string (e.g. \"B\"). "
        "For [type: MCQ]: \"options\" MUST have exactly 4 entries, ONE OR MORE may be correct (this is "
        "a multi-correct question — do not force it to a single answer), and \"answer\" MUST be a JSON "
        "array of every correct letter (e.g. [\"A\",\"C\"]), never a single string. "
        "For [type: NUMERICAL]: \"options\" MUST be an empty array [] — do NOT invent multiple-choice "
        "options for it under any circumstances — and \"answer\" MUST be a WHOLE NUMBER from 0 to 99 "
        "as a plain string (e.g. \"42\"), never a letter, never a decimal, never negative, never an "
        "expression. This is the JEE-Mains integer-answer format, so it is a HARD constraint on how "
        "you write the question: choose the given values so the final result works out to an exact "
        "integer in 0-99. If your reframed numbers would produce something like 37.714 or 12\\pi, "
        "CHANGE THE NUMBERS until the answer is a clean integer — or ask for a quantity that is "
        "(e.g. ask for \"the value of x\" where the answer is 25, or scale the asked quantity as "
        "\"find s/\\pi\" so the pi cancels). Verify by computing the final value before you answer. "
        "For [type: MATCHING_LIST]: do NOT write a normal prose stem with the matching data buried in "
        "it, and do NOT rely on any figure — instead fill \"list1\" and \"list2\" (see OUTPUT FORMAT "
        "below) with the two columns being matched, keep \"stem\" to just the short lead-in prose (e.g. "
        "\"Match the entries in List-I with the entries in List-II.\"), set \"fig\" to null always, and "
        "give \"options\" as 4 combination strings (e.g. \"I-Q, II-R, III-S, IV-P\") with exactly one "
        "correct, same \"answer\" letter shape as SCQ. "
        "For [type: ASSERTION_REASON]: do NOT write \"options\" at all (they are fixed and added "
        "automatically) — instead fill \"assertion\" and \"reason\" (see OUTPUT FORMAT below) with a "
        "fresh Assertion (A) statement and a fresh Reason (R) statement testing the same underlying "
        "concept, and set \"answer\" to a single letter A/B/C/D meaning exactly: A = \"A is true but R "
        "is false\", B = \"A is false but R is true\", C = \"Both A and R are true and R is the correct "
        "explanation of A\", D = \"Both A and R are true but R is not the correct explanation of A\". "
        "Choose whichever of these 4 relationships genuinely holds between your new Assertion and Reason "
        "— do not default to C/D out of habit."
    )
    if any(q.get('source_type') and q.get('source_type') != (q.get('type') or 'SCQ') for q in questions):
        # Seeds: the paper wanted a type the pool had too few of, so a question of
        # another type was picked for its concept (qbgPoolSelection.ts). The rule
        # above says "never change type"; for these the change IS the instruction.
        type_rule += (
            " EXCEPTION — questions whose tag also says \"CONVERT: the original below is X — write the "
            "new question as Y\": that original is only a SEED for the concept. Write a genuinely new "
            "question of type Y (the \"type\" in its tag) on the same concept, and follow every "
            "requirement above for type Y — not for X. For example an SCQ seed converted to NUMERICAL "
            "must come back with \"options\": [] and a whole-number answer 0-99, and a NUMERICAL seed "
            "converted to SCQ must come back with 4 options and one correct letter. Do not keep the "
            "seed's options, answer or answer format; do keep its concept, chapter and difficulty. "
            "This conversion overrides any instruction to keep the original's wording, numbers or "
            "asked quantity."
        )
    n = len(questions)
    mode_instruction = {
        "paraphrase": (
            "For each one, write a rephrased version that keeps the EXACT SAME numbers/values and asks "
            "for the EXACT SAME physical quantity as the original — only change the surface wording: "
            "swap the scenario's nouns, character names, objects, and context (e.g. \"a bus\" becomes "
            "\"a car\", \"a boy\" becomes \"a girl\") so it reads as a new question. Do NOT change any "
            "numerical value, unit, or which quantity is being solved for — the correct answer, the "
            "underlying computation, and the difficulty must be IDENTICAL to the original. This is a "
            "pure language paraphrase, not a new problem."
        ),
        "vary_numbers": (
            "For each one, write a new version that asks for the SAME physical quantity as the original "
            "(do not change what is being solved for — an original asking for velocity must still ask "
            "for velocity) but change the numerical values/data (and you may reword the scenario too). "
            "Keep the difficulty level roughly the same as the original — not harder, not easier."
        ),
        "full_rewrite": (
            "Treat each one as INSPIRATION ONLY, not a template to lightly edit: write a genuinely NEW "
            "question on the same topic/concept. You have full freedom to change the setup, the numbers, "
            "the scenario, and even WHICH physical quantity is being asked for (e.g. an original asking "
            "for velocity could become one asking for time, energy, or a ratio) — as long as it tests "
            "the same underlying concept/chapter. Make it SLIGHTLY MORE DIFFICULT than the original "
            "(never easier)."
        ),
    }[mode]
    difficulty_note = {
        "paraphrase": "the wording must read as new while the concept, numbers, and difficulty stay identical",
        "vary_numbers": "the numbers must change but the difficulty must stay about the same as the original",
        "full_rewrite": "it must be a bit harder than the original, not just reworded",
    }[mode]
    if difficulty not in DIFFICULTY_LEVELS:
        difficulty = "auto"
    if difficulty != "auto":
        # Explicit difficulty request \u2014 overrides whatever difficulty the chosen mode implies
        # (including "paraphrase"/"vary_numbers", which otherwise deliberately hold it fixed).
        mode_instruction += {
            "harder": (
                " MAKE IT HARDER: the reframed question must be clearly more demanding than the original. "
                "Raise the difficulty through the PHYSICS, not through uglier arithmetic \u2014 add one "
                "extra reasoning step (a quantity that must be derived before the one actually asked for), "
                "or bring in a second idea from the same chapter that has to be combined with the first, or "
                "ask for a quantity that needs the original result plus one more relation. It must still be "
                "a fair, unambiguous question a well-prepared student can finish in a single attempt, and "
                "your solution must derive every step correctly."
            ),
            "much_harder": (
                " MAKE IT SUBSTANTIALLY HARDER (JEE-Advanced level): the reframed question must need "
                "genuinely more work than the original \u2014 typically two or three chained steps, or two "
                "concepts from the chapter combined, or a non-obvious insight or limiting case before the "
                "arithmetic even starts. The difficulty must come from the physics and the reasoning, never "
                "from messier numbers or a longer read. It must stay a fair, unambiguous, fully solvable "
                "question, and your solution must derive every step correctly with no hand-waving."
            ),
        }[difficulty]
        if mode == "paraphrase":
            mode_instruction += (
                " Where this conflicts with the \"keep the exact same numbers and quantity\" instruction "
                "above, the difficulty requirement WINS: you may change values and add a step in order to "
                "make it harder, while keeping the original's scenario and concept recognisable."
            )
        difficulty_note = {
            "harder": "it must be clearly harder than the original, not merely reworded",
            "much_harder": ("it must be substantially harder than the original (JEE-Advanced level), while "
                            "staying fair, unambiguous and fully solvable"),
        }[difficulty]
    lines=[]
    lines.append(("You are an expert JEE/NEET physics problem author. Below are %d original MCQs "
        "extracted from a test, each tagged with its original question number in \"num\". " + mode_instruction +
        " Write a FRESH step-by-step solution and give the correct option(s) — see the type rule below "
        "for whether one or more options can be correct. "
        "The things that matter most, in order: (1) your response MUST contain EXACTLY %d objects in "
        "the \"questions\" array — one for EVERY original question listed below, no fewer, matched by "
        "its \"num\"; never skip, merge, summarize, or stop early even if some questions look similar or "
        "the batch is large — if you are unsure about one, still include your best attempt rather than "
        "omitting it; (2) ZERO errors — the physics and the arithmetic must be exactly correct, "
        "re-derive and re-check every number before writing the solution; (3) " + difficulty_note + ". "
        + fig_rule + sol_diagram_rule + new_fig_rule) % (n, n))
    lines.append(type_rule)
    # Placed immediately after the main instruction and the type rule, before the
    # formatting boilerplate: the syllabus decides whether a question is usable at
    # all, so it must not be buried at the end of a long prompt.
    syllabus_rule = _syllabus_rule(syllabus)
    if syllabus_rule:
        lines.append("")
        lines.append(syllabus_rule)
    # Same reasoning as the syllabus: these decide what kind of paper this is, so
    # they sit up here rather than after the formatting boilerplate.
    style_rule = _paper_style_rule(no_calculator=no_calculator, conceptual=conceptual)
    if style_rule:
        lines.append("")
        lines.append(style_rule)
    has_images = any(q.get('fig_name') or q.get('opt_img_names') for q in questions)
    if has_images:
        lines.append("Some questions below have a figure or image options (marked in [...] with a "
            "filename, e.g. q3_figure.png). To see them: if a ZIP of these images was attached to this "
            "chat, treat the attached file matching that exact filename as the primary source and do NOT "
            "search or fetch anything online for it. Only if no such ZIP was attached, and an image URL "
            "is listed next to the filename, open that URL instead. Either way, look at the actual "
            "diagram before rewriting that question, so any values, labels or configuration shown in it "
            "stay consistent with your new wording.")
    lines.append("")
    lines.append("OUTPUT FORMAT — return ONLY valid JSON (no markdown), shaped exactly like this:")
    _skeleton_fig_line = '      "fig": "q3_figure.png OR null",'
    if allow_diagram_changes:
        _skeleton_fig_line += (
            '\n      "fig_edit": "null, OR a precise description of exactly what changed in the diagram",'
            if not force_redraw else
            '\n      "fig_edit": "REQUIRED whenever \"fig\" is set, never null: exactly how to redraw the '
            'diagram so it matches this question",')
    if add_figures:
        _skeleton_fig_line += (
            '\n      "new_fig_desc": "null, OR a precise description of a NEW diagram to draw for a '
            'question that has none",')
    _skeleton_solution_line = (
        '      "solution": [ {"t":"short label:"}, {"m":"equation"}, {"t":"next short label:"}, {"m":"equation"} ]')
    if gen_solution_diagrams:
        _skeleton_solution_line += (
            ',\n      "sol_diagram_desc": "null, OR a precise description of a diagram the SOLUTION needs (see rule above)"')
    lines.append('''{
  "source_name": "%s",
  "questions": [
    {
      "num": 3,
      "chapter": "Short chapter name",
      "stem": [ {"t":"plain prose"}, {"m":"latex equation"}, {"t":"more prose"} ],
%s
      "options": [
         [ {"t":"..."},{"m":"..."} ],
         [ {"m":"..."} ],
         [ {"t":"..."} ],
         [ {"t":"..."} ]
      ],
      "answer": "A",
%s
    }
  ]
}''' % (source_name, _skeleton_fig_line, _skeleton_solution_line))
    lines.append("For a [type: NUMERICAL] question specifically: \"options\" MUST be [] (empty array) and "
        "\"answer\" MUST be a whole number 0-99 as a plain string (e.g. \"42\") — never the 4-entry options "
        "shape shown above, never a lettered answer, and never a decimal. Everything else "
        "(stem/solution/chapter/fig) keeps the same shape.")
    lines.append("For a [type: MCQ] question specifically: \"answer\" MUST be a JSON array of every correct "
        "letter, e.g. [\"A\",\"C\"] — never a single string, even if only one option happens to be correct.")
    lines.append('''For a [type: MATCHING_LIST] question specifically, also include "list1"/"list2" (List-I and '''
        '''List-II being matched), shaped like this — everything else (options/answer/solution/chapter) keeps '''
        '''the normal SCQ shape:
{
  "list1": [ {"label":"I","parts":[{"t":"..."}]}, {"label":"II","parts":[{"m":"..."}]}, '''
        '''{"label":"III","parts":[{"t":"..."}]}, {"label":"IV","parts":[{"t":"..."}]} ],
  "list2": [ {"label":"P","parts":[{"t":"..."}]}, {"label":"Q","parts":[{"m":"..."}]}, '''
        '''{"label":"R","parts":[{"t":"..."}]}, {"label":"S","parts":[{"t":"..."}]} ],
  "fig": null
}
"options" for this type are the 4 combination strings (e.g. "I-Q, II-R, III-S, IV-P" as a single '''
        '''{"t":...} part), exactly one correct, "answer" is that option's letter — same as SCQ.''')
    lines.append('''For a [type: ASSERTION_REASON] question specifically, also include "assertion"/"reason" '''
        '''instead of "options", shaped like this:
{
  "assertion": [ {"t":"..."}, {"m":"..."} ],
  "reason": [ {"t":"..."}, {"m":"..."} ]
}
Do NOT include "options" for this type at all — leave it out of the object entirely (the 4 fixed '''
        '''choices are added automatically). "answer" is a single letter A/B/C/D per the meanings given above, '''
        '''NOT the AR original's own '(A)'/'(B)' option letters.''')
    lines.append("")
    lines.append("RULES:")
    lines.append("- 'stem' / each option / 'solution' is a LIST of parts; each part is {\"t\":prose} OR {\"m\":latex}.")
    lines.append("- Put ONLY real equations in {\"m\":...} (LaTeX). Keep ordinary words and simple units in {\"t\":...}.")
    lines.append("- Variables inside {\"m\":...} render italic and units render upright automatically — do NOT add "
                  "your own italics/bold markup, just write plain LaTeX.")
    lines.append("- Write units in LaTeX like 6\\,\\Omega, 5\\,A, 9\\times10^{-5}\\,T so they render upright with a space — "
                  "but ONLY ever inside an {\"m\":...} part.")
    lines.append("- LaTeX belongs EXCLUSIVELY in {\"m\":...}. A {\"t\":...} part is plain prose that is shown to the "
                  "student verbatim — no backslash commands, no ^{} or _{} there. Writing "
                  "{\"t\":\"a speed of 8 m\\,s^{-2}\"} displays the literal characters "
                  "\"8 m\\,s^{-2}\" on screen, which looks broken. Put the quantity in its own math part instead: "
                  "{\"t\":\"a speed of \"},{\"m\":\"8\\,m\\,s^{-2}\"} — or, if you keep it in the text, write it the "
                  "way a person reads it: {\"t\":\"a speed of 8 m/s²\"}.")
    lines.append("- SPACING: parts are concatenated directly, so every {\"t\":...} part that sits next to a {\"m\":...} "
                  "part MUST include the needed space itself. Example — correct: {\"t\":\"radius \"},{\"m\":\"5\"},"
                  "{\"t\":\" m and\"}. Wrong (produces \"radius5 mand\"): {\"t\":\"radius\"},{\"m\":\"5\"},{\"t\":\"m and\"}. "
                  "Always leave a real space between a number and its unit, and between a word and the number that follows it.")
    # The old rule demanded "TERSE, MOSTLY EQUATIONS" and told the model to skip
    # explanation entirely, which produced solutions a student cannot follow —
    # "Range condition: 16 = A/4k^2 ⇒ A = 64k^2" with nothing saying where that
    # came from (2026-09-08 report). The reason for the old rule was a RENDERING
    # one: prose split across several {"t"}/{"m"} parts used to come out as
    # disconnected lines. sol_code keeps a sentence and its inline equation
    # together now, so the step can carry its reason without breaking apart.
    lines.append("- Solutions are STEP STYLE and must be EASY TO FOLLOW. Each step is a short label, "
                  "then its equation — and, where the step is not self-evident, ONE short sentence "
                  "(under ~20 words) saying WHY: which law or formula is being used, what is being "
                  "conserved, what condition is being applied, or what the result means. Aim for "
                  "enough steps that a student can follow the derivation without filling gaps in "
                  "themselves — do not compress two ideas into one line, and never jump from the "
                  "given data straight to the answer.")
    lines.append("- Name the principle when you first use it: \"Using conservation of momentum:\", "
                  "\"At maximum height the vertical velocity is zero:\", \"Comparing coefficients of "
                  "x^2:\" — a label that only repeats the symbols (\"Range condition:\") teaches "
                  "nothing on its own, so either say what makes it that condition or add the short "
                  "sentence described above.")
    lines.append("- Keep it a SOLUTION, not an essay: no restating the question, no background "
                  "lecture, no alternative methods, no closing summary. Every sentence must move the "
                  "derivation forward. Do NOT write a bare variable name as its own {\"m\":...} part "
                  "just to introduce it mid-sentence, and keep each prose part a complete short "
                  "phrase rather than a sentence chopped across several parts.")
    lines.append("- If your solution uses a symbol that is NOT already named in the question stem (a "
                  "variable you invented to set up the solution, e.g. x/y for two unknown rises, h for "
                  "an unlabeled height), say what it stands for the first time it appears — a short "
                  "tag is enough (e.g. {\"t\":\"Let x, y = rise in right, left arm:\"}). Skip this "
                  "entirely when every symbol you use already appears in the stem.")
    if add_figures:
        lines.append("- \"new_fig_desc\": null on any question that already has a figure, and null on any "
                      "question whose meaning is already fully clear from its words \u2014 only set it where "
                      "a diagram genuinely adds information. When set, it must fully and unambiguously "
                      "specify the diagram (every label, every value, the exact geometry/layout) and match "
                      "the stem's numbers exactly, so it can be drawn with no guessing.")
    if gen_solution_diagrams:
        lines.append("- \"sol_diagram_desc\": null on almost every question — only set it for the rare question "
                      "whose solution genuinely needs its own diagram per the rule above. When set, it must fully "
                      "and unambiguously specify the diagram (every label, every value, the exact geometry/layout) "
                      "so it can be drawn correctly with no guessing — an incomplete or vague description risks a "
                      "wrong diagram, which is worse than none.")
    lines.append("- \"num\" MUST equal the original question's number shown as \"QN.\" below — this is how your "
                  "answer gets matched back to the original; get it exactly right for every question.")
    lines.append("- COUNT CHECK before you respond: you were given %d original questions below — count the "
                  "objects in your \"questions\" array and confirm it is also %d. If it is not, go back and "
                  "add the missing one(s) instead of returning a short array." % (n, n))
    lines.append("- If a question's options are images (tagged \"options are images\" below), output "
                  "EVERY one of its options as {\"img\":\"q17_optA.png\"} using the EXACT filenames "
                  "given — never as text, and NEVER as an empty option. You cannot draw new "
                  "pictures, so those four images are the only options that question can ever "
                  "have. That constrains how far you may reframe it: you MUST keep asking the "
                  "same thing about the same values, so the existing pictures stay correct and "
                  "the same one stays the right answer — reword the sentence only, even in "
                  "full-rewrite mode. Do NOT change the equation, the numbers, the quantity "
                  "asked, or which option is correct. If you cannot reframe it under that "
                  "constraint, return the question with its ORIGINAL wording rather than "
                  "inventing a new one the images no longer match.")
    lines.append("- If a question has a figure and is NOT [type: MATCHING_LIST], set \"fig\" to the EXACT "
                  "filename given below — NEVER null when the original had a figure, even if your new wording "
                  "could technically stand without it.")
    lines.append("- If a question is tagged [type: NUMERICAL], output \"options\": [] and set \"answer\" to a "
                  "WHOLE NUMBER 0-99 — never fabricate multiple-choice options for it. Before you finalise "
                  "such a question, actually compute the answer: if it is not an exact integer in 0-99 "
                  "(e.g. 37.714, 12\\pi, 0.5, 250, -3), adjust the given data or the asked quantity until "
                  "it is. A decimal or out-of-range answer makes the question unusable and it will be "
                  "discarded.")
    lines.append("- If a question is tagged [type: MCQ], \"answer\" MUST be a JSON array (e.g. [\"B\"] even for "
                  "a single correct option, or [\"A\",\"D\"] for two) — never a bare string like \"B\".")
    lines.append("- If a question is tagged \"stem contains a TABLE\": its stem holds a two-column "
                  "table (typically List-I / List-II) that CANNOT be expressed with {\"t\"}/{\"m\"} "
                  "parts, so it would be silently lost. You MUST return \"list1\"/\"list2\" for that "
                  "question — same shape as [type: MATCHING_LIST] above — rebuilding the table from "
                  "the TABLE ROWS printed under the question, with your reframed content. Keep the "
                  "row pairing intact (row 1 of list1 pairs with row 1 of list2). Do this even when "
                  "the question is NOT tagged [type: MATCHING_LIST], and keep \"stem\" for the "
                  "lead-in prose only. The table is rendered back for you — do NOT try to draw it "
                  "with dashes or pipes inside a {\"t\"} part. If the question also has a figure, "
                  "keep \"fig\" as normal — the figure and the table are both preserved.")
    lines.append("- If a question is tagged [type: MATCHING_LIST]: set \"fig\" to null always (even if the "
                  "original had a figure/image table), fill \"list1\"/\"list2\" with fresh text instead of "
                  "reusing the old image, and if the original's List-I/List-II was itself a picture, look at "
                  "it (via the attached ZIP or URL, same as any other figure) to understand what concept is "
                  "being matched before writing the new lists.")
    lines.append("- If a question is tagged [type: ASSERTION_REASON]: write \"assertion\"/\"reason\" instead "
                  "of \"options\" — omit \"options\" entirely — and set \"answer\" to a single A/B/C/D letter "
                  "per the 4 fixed relationship meanings given above (never the AR original's own lettered "
                  "options, which describe something different from a plain SCQ's options).")
    if allow_diagram_changes:
        lines.append("- \"fig_edit\": null unless you changed something the figure shows; if you did, it MUST "
                      "follow the surgical-edit structure described above — exact original value + position, "
                      "exact new value, and a statement that everything else is unchanged. Never write a vague "
                      "instruction like \"update the diagram to match\" or \"redraw with new values\".")
    lines.append("- Verify each answer by re-doing the computation before choosing the option letter — accuracy is non-negotiable.")
    lines.append("")
    lines.append("=== ORIGINAL QUESTIONS ===")
    for q in questions:
        lines.append("")
        # The AI-facing tag shows the question's real type (SCQ/MCQ/NUMERICAL/
        # MATCHING_LIST) — see type_rule above for what each requires in the output.
        q_type = q.get('type') or 'SCQ'
        q_type = q_type if q_type in ('MCQ','NUMERICAL','MATCHING_LIST','ASSERTION_REASON') else 'SCQ'
        tag_parts=["type: %s"%q_type]
        # A seed picked to fill a type shortfall: "type" is the type to WRITE, and
        # source_type is what the original was — see the CONVERT clause in type_rule.
        src_type = q.get('source_type')
        if src_type and src_type != q_type:
            tag_parts.append("CONVERT: the original below is %s — write the new question as %s"
                             % (src_type, q_type))
        if q['fig_name']:
            u=fig_urls.get(q['fig_name'])
            tag_parts.append("figure available: "+q['fig_name']+(" — view it: %s"%u if u else ""))
        if q['opt_img_names']:
            opts=[nm+(" (%s)"%fig_urls[nm] if fig_urls.get(nm) else "") for nm in q['opt_img_names']]
            tag_parts.append("options are images: "+", ".join(opts))
        table_rows = q.get('table_rows') or []
        if table_rows:
            tag_parts.append("stem contains a TABLE — reproduce it via list1/list2")
        tag="  [%s]"%("; ".join(tag_parts))
        lines.append("Q%d.%s %s"%(q['num'],tag,q['q_text']))
        if table_rows:
            # The stem's plain text above has the table flattened into one run of
            # words; show the real rows so the model can rebuild the pairing.
            lines.append("   TABLE ROWS (cells separated by |):")
            for row in table_rows[:12]:
                lines.append("      " + row[:300])
        for ot in q['options_text']:
            lines.append("   "+ot)
        if not q['options_text'] and q['opt_img_names']:
            lines.append("   (four image options)")
        lines.append("   Answer: (%s)"%q['answer'])
        if q.get('sol_text'): lines.append("   Solution: "+str(q['sol_text'])[:600])
    return "\n".join(lines)
