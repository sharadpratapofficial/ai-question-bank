# -*- coding: utf-8 -*-
"""MCQ Reframer — Streamlit app.
Upload a .docx test -> extract originals + diagrams -> reframe with Claude/AI ->
download a folder (interactive HTML + diagrams)."""
import os, re, json, io, zipfile, tempfile, hashlib
import streamlit as st
from extract import extract, build_prompt
from htmlbuild import build_html, write_project
from csvbuild import build_csv, original_records, modified_records
import llm
import qbg
import imagegen
from logsetup import get_logger, LOG_FILE

log = get_logger("app")

@st.cache_data(ttl=300, show_spinner=False)
def _cached_llm_models(provider, api_key):
    return llm.list_models(provider, api_key)

@st.cache_data(ttl=300, show_spinner=False)
def _cached_image_models(provider, api_key):
    return imagegen.list_models(provider, api_key)

st.set_page_config(page_title="MCQ Reframer", page_icon="📝", layout="wide")
st.title("📝 MCQ Reframer")
st.caption("Upload a Word test → extract originals + diagrams → reframe with AI → download an interactive HTML folder.")

for k in ("work","data","sig","payload","built","mod_qbg","orig_qbg","assist_fig_urls"):
    if k not in st.session_state: st.session_state[k]=None


def render_qbg_push(label, records, figdir, src, kp):
    """Reusable QBG ingest UI (used for both reframed and original questions).
    label: human description; records: [{content,options,solution}]; kp: unique key prefix.
    Results persist in st.session_state[kp]."""
    st.caption("Push %s to QBG (one request each). "
               "The same content / bilingual_options / solutions as the CSV are sent." % label)
    if st.checkbox("Yes — ingest %s into QBG" % label, key=kp+"_chk"):
        cat_name=st.selectbox("Category", list(qbg.CATEGORIES)+["Other (enter category_id manually)"], key=kp+"_cat")
        if cat_name=="Other (enter category_id manually)":
            cat_id_manual=st.text_input("Enter category_configuration_id", key=kp+"_catman")
        c1,c2=st.columns([1,1])
        with c1:
            user=st.text_input("user (header)", value="Qbg sub admin", key=kp+"_user")
        with c2:
            uid_choice=st.selectbox("user-id (header)", list(qbg.USER_IDS)+["Other (enter manually)"], key=kp+"_uidsel")
            if uid_choice=="Other (enter manually)":
                user_id=st.text_input("Enter user-id", key=kp+"_uidman")
            else:
                user_id=qbg.USER_IDS[uid_choice]; st.caption("user-id: %s"%user_id)
        token=st.text_input("Authorization token", type="password", key=kp+"_tok",
            help="'Bearer ' is added automatically if you don't include it. Used only for this request; not stored.")
        st.caption("Constant headers — organization-id: %s · client-type: QBG · Content-Type: application/json"
                   % qbg.ORG_ID)
        nimg=sum(1 for r in records if 'title="' in (r.get("content") or "")
                 or 'title="' in (r.get("solution") or "")
                 or any('title="' in (t or "") for _,t in (r.get("options") or [])))
        up_imgs=st.checkbox("Upload diagram images to QBG (%d question(s) have images)"%nimg,
            value=bool(nimg), disabled=not nimg, key=kp+"_img",
            help="Uploads each diagram to PenPencil's own S3 using the auth above, then fills the image src. "
                 "Without this, images are sent as empty <img src=\"\" /> and won't display in QBG.")
        if st.button("🚀 Push to QBG", type="primary", key=kp+"_btn"):
            if not (token and user and user_id):
                st.error("Please fill the Authorization token, user and user-id."); st.stop()
            cat_id=cat_id_manual if cat_name=="Other (enter category_id manually)" else qbg.CATEGORIES[cat_name]
            if not cat_id:
                st.error("Please enter a category_configuration_id."); st.stop()
            results=[]; resolved=[]
            uploader=qbg.qbg_uploader(token, user, user_id) if up_imgs else None
            cache={}
            prog=st.progress(0.0, text="Ingesting…")
            for i,rec in enumerate(records,1):
                try:
                    rec2=qbg.resolve_images(rec, figdir, uploader, cache) if up_imgs else rec
                    resolved.append(rec2)
                    uid,_=qbg.ingest(rec2, cat_id, token, user, user_id)
                    results.append({"num":i,"unique_id":uid,"ok":bool(uid)})
                except Exception as e:
                    resolved.append(rec)
                    results.append({"num":i,"unique_id":None,"ok":False,"error":str(e)})
                prog.progress(i/len(records), text="Ingesting %d/%d"%(i,len(records)))
            st.session_state[kp]={"results":results,"resolved":resolved,"src":src,"figdir":figdir}

    res=st.session_state.get(kp)
    if res:
        results=res["results"]; ok=sum(1 for r in results if r.get("ok"))
        if ok==len(results):
            st.success("All %d questions ingested into QBG."%ok)
        else:
            st.warning("%d of %d questions ingested; the rest failed (see below)."%(ok,len(results)))
        st.markdown("#### Unique IDs")
        st.dataframe([{"Q":r["num"],
                       "unique_id":r.get("unique_id") or "—",
                       "status":"ok" if r.get("ok") else ("failed: "+str(r.get("error","no unique_id"))[:80])}
                      for r in results], use_container_width=True, hide_index=True)
        ids=[r["unique_id"] for r in results if r.get("ok") and r.get("unique_id")]
        if ids:
            st.caption("Copy all %d unique IDs (hover the box → click the copy icon, top-right):"%len(ids))
            st.code("\n".join(ids), language="text")
        res_html=qbg.results_html(res["src"], res["resolved"], results, res["figdir"])
        st.download_button("⬇️ Download %s_qbg_results.html"%res["src"],
            res_html.encode("utf-8"), file_name=res["src"]+"_qbg_results.html", mime="text/html", key=kp+"_dl")
        with st.expander("Preview questions with unique IDs", expanded=True):
            st.components.v1.html(res_html, height=700, scrolling=True)

def _zip_bytes(named_paths):
    """named_paths: [(arcname, path)]. Returns zip file bytes, skipping any missing files."""
    buf=io.BytesIO()
    with zipfile.ZipFile(buf,"w",zipfile.ZIP_DEFLATED) as zf:
        for name,path in named_paths:
            if os.path.exists(path): zf.write(path, name)
    return buf.getvalue()

def _regen_figures(questions, figdir, provider, api_key, model):
    """Redraw each question's 'fig' whose reframed JSON set a non-null 'fig_edit', via
    imagegen.edit_image. Returns (new_questions, results) where results is
    [{"num","status":"regenerated"|"failed","detail"}]. Leaves 'fig' untouched on failure."""
    out=[]; results=[]
    for i,q in enumerate(questions,1):
        q=dict(q)
        fig=q.get("fig"); edit=q.get("fig_edit")
        if fig and edit:
            src_path=os.path.join(figdir, fig)
            if not os.path.exists(src_path):
                results.append({"num":i,"status":"failed","detail":"original figure %s not found"%fig})
            else:
                try:
                    with open(src_path,"rb") as f: orig_bytes=f.read()
                    new_bytes=imagegen.edit_image(provider, api_key, model, orig_bytes, "image/png", edit)
                    new_name="q%d_figure_ai.png"%i
                    with open(os.path.join(figdir,new_name),"wb") as f: f.write(new_bytes)
                    q["fig"]=new_name
                    results.append({"num":i,"status":"regenerated","detail":new_name})
                except Exception as e:
                    results.append({"num":i,"status":"failed","detail":str(e)[:400]})
        out.append(q)
    return out, results

def do_build(parsed, regen_diagrams=False, diag_provider=None, diag_key=None, diag_model=None):
    data=st.session_state.data
    questions=parsed.get("questions") if isinstance(parsed,dict) else parsed
    if not questions:
        log.error("do_build: no 'questions' array in the pasted/returned JSON")
        st.error("No 'questions' array found in the JSON."); return
    src=(parsed.get("source_name") if isinstance(parsed,dict) else None) or data["source_name"]
    log.info("do_build start: src=%s questions=%d regen_diagrams=%s", src, len(questions), regen_diagrams)
    problems=[]
    for i,q in enumerate(questions,1):
        for key in ("stem","options","answer","solution"):
            if key not in q: problems.append("Q%d missing '%s'"%(i,key))
        if q.get("options") and len(q["options"])!=4:
            problems.append("Q%d has %d options (expected 4)"%(i,len(q["options"])))
    if problems:
        log.error("do_build: JSON validation problems: %s", problems)
        st.error("JSON validation problems:\n- "+"\n- ".join(problems[:20])); return
    if regen_diagrams:
        if not diag_key:
            log.error("do_build: regen_diagrams requested but no diag_key entered")
            st.error("Diagram redraw is on but no image-model API key was entered — add one or "
                      "switch back to 'Keep the original diagram'."); return
        with st.spinner("Redrawing diagrams the reframed JSON flagged as changed…"):
            questions,regen_results=_regen_figures(questions, data["figdir"], diag_provider, diag_key, diag_model)
        changed=[r for r in regen_results if r["status"]=="regenerated"]
        failed=[r for r in regen_results if r["status"]=="failed"]
        log.info("do_build: diagram regen — %d changed, %d failed", len(changed), len(failed))
        if changed:
            st.info("Redrew %d diagram(s): %s"%(len(changed), ", ".join("Q%d"%r["num"] for r in changed)))
        if failed:
            log.error("do_build: diagram regen failures: %s", failed)
            st.warning("Could not redraw %d diagram(s), original kept: %s"%(len(failed),
                "; ".join("Q%d (%s)"%(r["num"],r["detail"]) for r in failed)))
    try:
        html=build_html(src, questions, data["originals"], data["figdir"])
        outroot=tempfile.mkdtemp(prefix="mcq_out_")
        folder,zip_path=write_project(outroot, src, html, data["figdir"])
        with open(zip_path,"rb") as f: zbytes=f.read()
        log.info("do_build ok: src=%s questions=%d zip=%s", src, len(questions), zip_path)
        st.success("Built **%s** with %d questions."%(src,len(questions)))
        st.download_button("⬇️ Download %s.zip"%src, zbytes, file_name=src+".zip", mime="application/zip")
        with st.expander("Preview the HTML", expanded=True):
            st.components.v1.html(html, height=700, scrolling=True)
        # ---- CSV of the MODIFIED questions ----
        try:
            mod_recs=modified_records(questions, data["figdir"])
            mod_csv=build_csv(mod_recs)
            # Keep built artifacts so the QBG ingest step survives reruns.
            prev=st.session_state.built or {}
            if prev.get("src")!=src or len(prev.get("records") or [])!=len(mod_recs):
                st.session_state.mod_qbg=None
            st.session_state.built={"src":src,"records":mod_recs,"html":html,"figdir":data["figdir"]}
            st.markdown("#### CSV — modified questions")
            st.download_button("⬇️ Download %s_modified.csv"%src, mod_csv.encode("utf-8"),
                file_name=src+"_modified.csv", mime="text/csv")
            with st.expander("Copy modified-questions CSV (content / bilingual_options / solutions)"):
                st.code(mod_csv, language="text")
        except Exception as e:
            log.exception("do_build: modified CSV build failed for src=%s", src)
            st.warning("Could not build the modified CSV: %s"%e)
    except Exception as e:
        log.exception("do_build: build_html/write_project failed for src=%s", src)
        st.error("Build failed: %s — see logs/app.log for the full traceback."%e)

# ---------------- STEP 1 ----------------
st.header("Step 1 — Provide the questions")
src_mode=st.radio("How do you want to provide questions?",
    ["Upload a .docx file", "Fetch by QBG unique_id (already-authored questions)"], index=0)

if src_mode.startswith("Upload"):
    up=st.file_uploader("Choose a .docx test (questions → answer key → solutions)", type=["docx"])
    if up is not None:
        sig=hashlib.md5(up.getvalue()).hexdigest()
        if st.session_state.sig!=sig:
            work=tempfile.mkdtemp(prefix="mcq_")
            docx_path=os.path.join(work, up.name)
            with open(docx_path,"wb") as f: f.write(up.getvalue())
            log.info("upload received: %s (%d bytes)", up.name, len(up.getvalue()))
            try:
                with st.spinner("Extracting questions, equations and diagrams…"):
                    st.session_state.data=extract(docx_path, work)
                st.session_state.work=work; st.session_state.sig=sig; st.session_state.payload=None
                st.session_state.built=None; st.session_state.mod_qbg=None; st.session_state.orig_qbg=None
                st.session_state.assist_fig_urls=None
            except Exception as e:
                log.exception("extraction failed for %s", up.name)
                st.error("Extraction failed: %s — see logs/app.log for the full traceback."%e); st.stop()

else:
    st.caption("Paste one QBG unique_id per line. Each question is fetched with its content / "
               "options / solution already filled in — diagram URLs are already public (PenPencil's "
               "own S3), so no upload step is needed to let an AI model see them.")
    ids_text=st.text_area("QBG unique_ids", height=140,
        placeholder="4ii5mxgv84bkvg16rv8akjy1j\nel9dtimjg18xf49stwcr2fvv4\n...")
    qc1,qc2=st.columns([1,1])
    with qc1:
        q_user=st.text_input("user (header)", value="Qbg sub admin", key="qsrc_user")
    with qc2:
        q_uidsel=st.selectbox("user-id (header)", list(qbg.USER_IDS)+["Other (enter manually)"], key="qsrc_uidsel")
        q_user_id=st.text_input("Enter user-id", key="qsrc_uidman") if q_uidsel=="Other (enter manually)" \
            else qbg.USER_IDS[q_uidsel]
    q_token=st.text_input("Authorization token", type="password", key="qsrc_tok",
        help="'Bearer ' is added automatically if omitted. Used only for this fetch; not stored.")
    if st.button("🔎 Fetch from QBG", type="primary"):
        ids=[x.strip() for x in re.split(r"[\s,]+", ids_text) if x.strip()]
        if not ids:
            st.error("Paste at least one unique_id.")
        elif not (q_token and q_user and q_user_id):
            st.error("Please fill the Authorization token, user and user-id.")
        else:
            sig=hashlib.md5(("qbg:"+",".join(sorted(ids))).encode()).hexdigest()
            work=tempfile.mkdtemp(prefix="mcq_")
            log.info("qbg fetch requested: %d id(s)", len(ids))
            try:
                with st.spinner("Fetching %d question(s) from QBG…"%len(ids)):
                    d=qbg.qbg_extract(ids, q_token, q_user, q_user_id, work)
                st.session_state.data=d; st.session_state.work=work; st.session_state.sig=sig
                st.session_state.payload=None; st.session_state.built=None
                st.session_state.mod_qbg=None; st.session_state.orig_qbg=None
                st.session_state.assist_fig_urls=d.get("fig_urls") or {}
                if d.get("missing_ids"):
                    st.warning("%d id(s) were not returned by QBG: %s"
                               %(len(d["missing_ids"]), ", ".join(d["missing_ids"])))
            except Exception as e:
                log.exception("qbg fetch failed for %d id(s)", len(ids))
                st.error("QBG fetch failed: %s — see logs/app.log for the full traceback."%e); st.stop()

data=st.session_state.data
if data:
    nfig=sum(1 for q in data["questions"] if q["fig_name"])
    nimg=sum(1 for q in data["questions"] if q["opt_img_names"])
    st.success("Extracted **%d** questions · %d with a figure · %d with image-options · source: **%s**"
               %(len(data["questions"]),nfig,nimg,data["source_name"]))

    # ---- CSV of the ORIGINAL (input) questions ----
    try:
        orig_csv=build_csv(original_records(data))
        st.markdown("#### CSV — original (input) questions")
        st.download_button("⬇️ Download %s_original.csv"%data["source_name"], orig_csv.encode("utf-8"),
            file_name=data["source_name"]+"_original.csv", mime="text/csv")
        with st.expander("Copy original-questions CSV (content / bilingual_options / solutions)"):
            st.code(orig_csv, language="text")
    except Exception as e:
        st.warning("Could not build the original CSV: %s"%e)

    # ---- Optional: send the ORIGINAL (unmodified) questions straight to QBG ----
    with st.expander("Optional — Send ORIGINAL (unmodified) questions to QBG", expanded=False):
        st.caption("Inject the input Word file's questions directly into QBG — same MathType MathML as the reframed output, no reframing needed.")
        try:
            orig_qbg_recs=qbg.original_qbg_records(data)
            render_qbg_push("the %d original questions"%len(orig_qbg_recs),
                orig_qbg_recs, data["figdir"], data["source_name"]+"_original", "orig_qbg")
        except Exception as e:
            st.warning("Could not prepare original questions for QBG: %s"%e)

    # ---------------- STEP 2 ----------------
    st.header("Step 2 — Reframe the questions")
    mode=st.radio("How do you want to reframe?",
        ["Automatic — call an AI API", "Assisted — copy the prompt into Claude yourself"], index=0)

    st.markdown("**Diagrams**")
    diag_choice=st.radio("What should happen to each question's diagram/figure?",
        ["Keep the original diagram (default)",
         "Let AI redraw the diagram to match the new question (experimental)"],
        index=0, key="diag_choice")
    regen_diagrams=diag_choice.startswith("Let AI")
    diag_provider=diag_model=diag_key=None
    if regen_diagrams:
        st.caption("Only questions where the reframed JSON sets a \"fig_edit\" (a described diagram "
                   "change) get redrawn — every other figure is kept exactly as extracted. This calls "
                   "an image-editing AI and is experimental: always compare the new diagram against the "
                   "new question text before trusting it.")
        dc1,dc2=st.columns([1,1])
        with dc1:
            diag_provider=st.selectbox("Image model provider", imagegen.PROVIDERS, key="diag_provider")
        with dc2:
            diag_key=st.text_input("Image-model API key", type="password", key="diag_key",
                help="Used only to redraw diagrams for this build; not stored. Also used to list live models below.")
        diag_models=_cached_image_models(diag_provider, diag_key)
        diag_default=imagegen.DEFAULT_MODEL.get(diag_provider)
        diag_idx=diag_models.index(diag_default) if diag_default in diag_models else 0
        dmc1,dmc2=st.columns([5,1])
        with dmc1:
            diag_model=st.selectbox("Model (live list, merged with every model seen before for this provider)",
                diag_models, index=diag_idx)
        with dmc2:
            st.write("")
            if st.button("🔄", key="refresh_diag_models", help="Re-fetch the live model list for %s"%diag_provider):
                _cached_image_models.clear(); st.rerun()

    active_prompt=build_prompt(data["source_name"], data["questions"],
        fig_urls=(st.session_state.assist_fig_urls or {}) if mode.startswith("Assisted") else None,
        allow_diagram_changes=regen_diagrams)

    if mode.startswith("Automatic"):
        c1,c2=st.columns([1,1])
        with c1:
            provider=st.selectbox("Provider", llm.PROVIDERS, index=1)
        with c2:
            api_key=st.text_input("API key", type="password",
                help="Used only to make this one request; not stored anywhere. Also used to list live models below.")
        model_opts=_cached_llm_models(provider, api_key)
        model_default=llm.DEFAULT_MODEL.get(provider)
        model_idx=model_opts.index(model_default) if model_default in model_opts else 0
        mc1,mc2=st.columns([5,1])
        with mc1:
            model=st.selectbox("Model (live list, merged with every model seen before for this provider)",
                model_opts, index=model_idx)
        with mc2:
            st.write("")
            if st.button("🔄", key="refresh_llm_models", help="Re-fetch the live model list for %s"%provider):
                _cached_llm_models.clear(); st.rerun()
        send_imgs=st.checkbox("Send diagram images to the AI (%d found)"%(nfig+nimg),
            value=bool(nfig or nimg), disabled=not (nfig or nimg),
            help="Sends each question's figure/option-image alongside the prompt so the model can "
                 "see the diagram, not just its filename. Use a vision-capable model.")
        if st.button("🤖 Generate with AI", type="primary"):
            if not api_key: st.error("Please enter your API key."); st.stop()
            try:
                images=llm.collect_images(data["questions"], data["figdir"]) if send_imgs else []
                with st.spinner("Asking %s to reframe all questions%s…"
                                 %(provider, " (with %d image(s))"%len(images) if images else "")):
                    st.session_state.payload=llm.generate(provider, api_key, model, active_prompt, images=images)
                st.success("AI returned the reframed questions. Building…")
            except Exception as e:
                st.error("AI request failed: %s — see logs/app.log for the full traceback."%e)
        if st.session_state.payload:
            with st.expander("Show the AI's JSON", expanded=False):
                st.code(json.dumps(st.session_state.payload, ensure_ascii=False, indent=2)[:8000], language="json")
            do_build(st.session_state.payload, regen_diagrams, diag_provider, diag_key, diag_model)

    else:
        st.markdown("Copy the prompt, paste it into **Claude**, then paste the JSON it returns below.")

        fig_names=sorted({q["fig_name"] for q in data["questions"] if q["fig_name"]}
                          | {nm for q in data["questions"] for nm in (q["opt_img_names"] or [])})
        known_urls=data.get("fig_urls") or {}          # already public — set when the source is QBG unique_ids
        uncovered=[fn for fn in fig_names if fn not in known_urls]
        if fig_names:
            fig_zip=_zip_bytes([(fn, os.path.join(data["figdir"], fn)) for fn in fig_names])
            st.download_button("⬇️ Download figures.zip (%d image(s))"%len(fig_names), fig_zip,
                file_name="figures.zip", mime="application/zip",
                help="Attach these images to your Claude chat along with the pasted prompt so it can "
                     "actually see the diagrams, not just their filenames.")
            if not uncovered:
                st.caption("All %d image(s) already have a public URL (fetched from QBG) — they're included "
                           "in the prompt below, no upload needed."%len(fig_names))
            else:
                with st.expander("Optional — upload figures to QBG S3 so Claude can actually see them (%d image(s))"
                                  % len(uncovered)):
                    st.caption("Uploads each question's diagram/option-image to PenPencil's own S3 (same uploader "
                               "Step 3 uses) and drops the resulting URL next to its filename in the prompt below. "
                               "Ask Claude to open each link before rewriting that question — it can't change what "
                               "the figure shows, but it can read the values/labels in it so the reworded question "
                               "stays consistent.")
                    c1,c2=st.columns([1,1])
                    with c1:
                        fu_user=st.text_input("user (header)", value="Qbg sub admin", key="fu_user")
                    with c2:
                        fu_uidsel=st.selectbox("user-id (header)", list(qbg.USER_IDS)+["Other (enter manually)"], key="fu_uidsel")
                        fu_user_id=st.text_input("Enter user-id", key="fu_uidman") if fu_uidsel=="Other (enter manually)" \
                            else qbg.USER_IDS[fu_uidsel]
                    fu_token=st.text_input("Authorization token", type="password", key="fu_tok",
                        help="'Bearer ' is added automatically if omitted. Used only for this upload; not stored.")
                    if st.button("📤 Upload figures & add URLs to prompt"):
                        if not (fu_token and fu_user and fu_user_id):
                            st.error("Please fill the Authorization token, user and user-id.")
                        else:
                            uploader=qbg.qbg_uploader(fu_token, fu_user, fu_user_id)
                            url_map={}; errs=[]
                            prog=st.progress(0.0, text="Uploading…")
                            for i,fn in enumerate(uncovered,1):
                                try:
                                    url_map[fn]=uploader(os.path.join(data["figdir"], fn))
                                except Exception as e:
                                    errs.append("%s: %s"%(fn,e))
                                prog.progress(i/len(uncovered), text="Uploading %d/%d"%(i,len(uncovered)))
                            st.session_state.assist_fig_urls={**(st.session_state.assist_fig_urls or {}), **url_map}
                            if errs:
                                st.warning("Uploaded %d/%d; failed: %s"%(len(url_map),len(uncovered),"; ".join(errs)[:300]))
                            else:
                                st.success("Uploaded all %d figure(s) — URLs added to the prompt below."%len(url_map))

        st.download_button("⬇️ Download prompt.txt", active_prompt, file_name="reframe_prompt.txt")
        with st.expander("Show / copy the prompt", expanded=False):
            st.code(active_prompt, language="text")
        js=st.text_area("Paste the JSON returned by Claude", height=220,
            placeholder='{ "source_name": "...", "questions": [ ... ] }')
        if st.button("🔧 Build HTML folder", type="primary"):
            try:
                parsed=json.loads(js)
            except Exception as e:
                log.error("Assisted-mode paste was not valid JSON: %s", e)
                st.error("That is not valid JSON: %s"%e); st.stop()
            do_build(parsed, regen_diagrams, diag_provider, diag_key, diag_model)

# ---------------- STEP 3 — INGEST INTO QBG ----------------
built=st.session_state.built
if built:
    st.header("Step 3 — Ingest into QBG")
    render_qbg_push("these %d reframed questions"%len(built["records"]),
        built["records"], built["figdir"], built["src"], "mod_qbg")

st.divider()
st.caption("Plain prose stays editable; only equations become MathML (MathType). "
           "Each diagram file in the folder is named per question — upload it to your software and replace the src in the copied code. "
           "Tip: always spot-check the new answer key.")

with st.expander("🩺 Diagnostics — recent log"):
    st.caption("Every extraction / AI call / build / QBG push / diagram redraw logs here (never API keys) — "
               "the file lives at %s, so an error can be diagnosed straight from it without a screenshot."%LOG_FILE)
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, "rb") as f:
            log_bytes=f.read()
        tail="\n".join(log_bytes.decode("utf-8", "replace").splitlines()[-200:])
        st.code(tail or "(empty)", language="text")
        st.download_button("⬇️ Download full log", log_bytes, file_name="app.log", mime="text/plain")
    else:
        st.caption("No log file yet.")
