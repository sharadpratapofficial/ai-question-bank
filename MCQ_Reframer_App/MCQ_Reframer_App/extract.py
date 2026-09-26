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
        questions.append({'num':N,'q_text':q_text,'options_text':opt_texts,'options_html':opt_html,'stem_html':stem_html,
            'answer':answers.get(N,''),'sol_text':_txt(re.sub(r'^\d+\.\s*Text Solution:?','', txt[sol_starts[qi]] if qi<len(sol_starts) else '')) or (sols.get(N,'') and _txt(sols[N])),
            'fig_name':fig_name,'opt_img_names':opt_img_names,'sol_img_names':sol_imgs.get(N,[])})
    prompt=build_prompt(source_name, questions)
    nfig=sum(1 for q in questions if q['fig_name'])
    log.info("extract ok: source=%s questions=%d figures=%d", source_name, len(questions), nfig)
    return {'source_name':source_name,'questions':questions,'originals':originals,
            'figdir':figdir,'prompt':prompt}

def build_prompt(source_name, questions, fig_urls=None, allow_diagram_changes=False):
    """fig_urls: optional {figdir filename: public URL}, for when the figures/option-images
    have been uploaded somewhere the assisted model can open (see app.py Assisted-mode section).
    allow_diagram_changes: when True, the model may also change what a figure shows (and must
    describe the change in "fig_edit" so app.py can regenerate the diagram); default keeps the
    original diagram untouched, as before."""
    fig_urls=fig_urls or {}
    fig_rule = (
        "If a question has a figure, you MUST keep the data consistent with that figure (you cannot "
        "change what the figure shows, but you can still change what is being asked about it)."
    ) if not allow_diagram_changes else (
        "If a question has a figure, you MAY also change the values/configuration it shows (e.g. a "
        "resistor's value, a distance, an angle) as long as the new diagram would still make physical "
        "sense — but only when you do, fill \"fig_edit\" with a precise, self-contained description of "
        "exactly what changes and what stays the same, written for an image-editing AI that will redraw "
        "it from the original diagram. If the figure's data is unchanged, set \"fig_edit\" to null."
    )
    lines=[]
    lines.append(("You are an expert JEE/NEET physics problem author. Below are %d original MCQs "
        "extracted from a test. Treat each one as INSPIRATION ONLY, not a template to lightly edit: "
        "write a genuinely NEW question on the same topic/concept. You have full freedom to change "
        "the setup, the numbers, the scenario, and even WHICH physical quantity is being asked for "
        "(e.g. an original asking for velocity could become one asking for time, energy, or a ratio) "
        "— as long as it tests the same underlying concept/chapter. Write a FRESH step-by-step solution "
        "and give the correct option. Keep each question single-correct and make it SLIGHTLY MORE "
        "DIFFICULT than the original (never easier). The two things that matter most: (1) ZERO errors — "
        "the physics and the arithmetic must be exactly correct, re-derive and re-check every number "
        "before writing the solution; (2) it must be a bit harder than the original, not just reworded. "
        + fig_rule) % len(questions))
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
    lines.append('''{
  "source_name": "%s",
  "questions": [
    {
      "chapter": "Short chapter name",
      "stem": [ {"t":"plain prose"}, {"m":"latex equation"}, {"t":"more prose"} ],
      "fig": "q3_figure.png OR null",
      "options": [
         [ {"t":"..."},{"m":"..."} ],
         [ {"m":"..."} ],
         [ {"t":"..."} ],
         [ {"t":"..."} ]
      ],
      "answer": "A",
      "solution": [ {"t":"short label:"}, {"m":"equation"}, {"t":"next short label:"}, {"m":"equation"} ]
    }
  ]
}''' % source_name)
    if allow_diagram_changes:
        lines[-1]=lines[-1].replace(
            '"fig": "q3_figure.png OR null",',
            '"fig": "q3_figure.png OR null",\n      "fig_edit": "null, OR a precise description of exactly what changed in the diagram",')
    lines.append("")
    lines.append("RULES:")
    lines.append("- 'stem' / each option / 'solution' is a LIST of parts; each part is {\"t\":prose} OR {\"m\":latex}.")
    lines.append("- Put ONLY real equations in {\"m\":...} (LaTeX). Keep ordinary words and simple units in {\"t\":...}.")
    lines.append("- Variables inside {\"m\":...} render italic and units render upright automatically — do NOT add "
                  "your own italics/bold markup, just write plain LaTeX.")
    lines.append("- Write units in LaTeX like 6\\,\\Omega, 5\\,A, 9\\times10^{-5}\\,T so they render upright with a space.")
    lines.append("- SPACING: parts are concatenated directly, so every {\"t\":...} part that sits next to a {\"m\":...} "
                  "part MUST include the needed space itself. Example — correct: {\"t\":\"radius \"},{\"m\":\"5\"},"
                  "{\"t\":\" m and\"}. Wrong (produces \"radius5 mand\"): {\"t\":\"radius\"},{\"m\":\"5\"},{\"t\":\"m and\"}. "
                  "Always leave a real space between a number and its unit, and between a word and the number that follows it.")
    lines.append("- Solutions must be STEP STYLE and TERSE, MOSTLY EQUATIONS: alternate a short label of 2-6 words "
                  "(e.g. \"Peak current:\", \"Using efficiency:\") with its equation as the very next part. Do NOT "
                  "narrate the derivation as flowing sentences — never write something like \"Let l1 be the pulley "
                  "segment and l2 = ... the wall segment, so l1 + l2 = constant\" split across several {\"t\"}/{\"m\"} "
                  "parts; that reads as broken, disconnected lines when rendered. Skip general explanation/setup "
                  "prose entirely and go straight from a short label to the calculation. Do not give a bare "
                  "variable name its own {\"m\":...} part just to introduce it mid-sentence.")
    lines.append("- If a question's options are images, output that option as {\"img\":\"q17_optA.png\"} using the EXACT filenames given below.")
    lines.append("- If a question has a figure, set \"fig\" to the EXACT filename given below; otherwise set \"fig\": null.")
    if allow_diagram_changes:
        lines.append("- \"fig_edit\": null unless you changed something the figure shows; if you did, describe the "
                      "exact change (what's different, what's unchanged) precisely enough for an image-editing AI "
                      "to redraw it correctly from the original.")
    lines.append("- Verify each answer by re-doing the computation before choosing the option letter — accuracy is non-negotiable.")
    lines.append("")
    lines.append("=== ORIGINAL QUESTIONS ===")
    for q in questions:
        lines.append("")
        figinfo=[]
        if q['fig_name']:
            u=fig_urls.get(q['fig_name'])
            figinfo.append("figure available: "+q['fig_name']+(" — view it: %s"%u if u else ""))
        if q['opt_img_names']:
            opts=[nm+(" (%s)"%fig_urls[nm] if fig_urls.get(nm) else "") for nm in q['opt_img_names']]
            figinfo.append("options are images: "+", ".join(opts))
        tag=("  [%s]"%("; ".join(figinfo))) if figinfo else ""
        lines.append("Q%d.%s %s"%(q['num'],tag,q['q_text']))
        for ot in q['options_text']:
            lines.append("   "+ot)
        if not q['options_text'] and q['opt_img_names']:
            lines.append("   (four image options)")
        lines.append("   Answer: (%s)"%q['answer'])
        if q.get('sol_text'): lines.append("   Solution: "+str(q['sol_text'])[:600])
    return "\n".join(lines)
