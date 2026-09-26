# -*- coding: utf-8 -*-
"""Build the interactive HTML folder from reframed questions JSON + extracted originals/figures."""
import os, base64, html as _html, json, zipfile, shutil
from mathconv import field_html, sol_code

def _parts(x):
    """Normalize a JSON list of {'t':..}/{'m':..} into [('t',..),('m',..)]."""
    out=[]
    for p in x:
        if 't' in p: out.append(('t', p['t']))
        elif 'm' in p: out.append(('m', p['m']))
    return out

def _b64(path):
    ext=os.path.splitext(path)[1].lower().lstrip('.')
    mime='image/png' if ext=='png' else ('image/jpeg' if ext in('jpg','jpeg') else 'image/'+ext)
    with open(path,'rb') as f: return 'data:%s;base64,%s'%(mime, base64.b64encode(f.read()).decode())

def esc(t): return _html.escape(t)

CSS = """
:root{--navy:#1f3a5f;--blue:#1a4e8a;--green:#1b7a3d;--bg:#f5f6f8;--line:#dfe3e8;}
*{box-sizing:border-box}
body{margin:0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c2530;background:var(--bg);line-height:1.5}
header.top{background:var(--navy);color:#fff;padding:18px 22px}
header.top h1{margin:0;font-size:20px}header.top p{margin:4px 0 0;font-size:13px;opacity:.9}
.wrap{max-width:1180px;margin:0 auto;padding:18px}
.qblock{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:18px 0;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.qhead{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:2px solid var(--navy);padding-bottom:8px;margin-bottom:10px;flex-wrap:wrap}
.qnum{font-size:18px;font-weight:700;color:var(--navy)}.chap{font-size:12px;color:#667;font-style:italic;margin-left:10px}
.hbtns{display:flex;gap:8px;flex-wrap:wrap}
.cmp{background:#eef1f5;color:var(--navy);border:1px solid #c3ccd6;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
.cmp:hover{background:#e0e6ee}.cmp.on{background:#d9b310;color:#3a2f00;border-color:#c9a400}
.copyall{background:var(--navy);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
.copyall:hover{background:#16314f}
.qbody.cmp-on{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}
.card{border:1px solid var(--line);border-radius:10px;margin:10px 0;overflow:hidden}
.chead{display:flex;justify-content:space-between;align-items:center;background:#eef1f5;padding:6px 12px;border-bottom:1px solid var(--line)}
.clabel{font-size:12px;font-weight:700;letter-spacing:.5px;color:var(--blue)}
.copy{background:#fff;border:1px solid #c3ccd6;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;color:#33455a}
.copy:hover{background:#e8edf3}.copy.ok,.copyall.ok{background:var(--green);color:#fff;border-color:var(--green)}
.render{padding:12px 14px;font-size:16px}.render p{margin:.35em 0}
.render img{display:block;margin:8px 0;max-width:100%;height:auto}
.dnote{color:#c0392b;font-size:12.5px;font-weight:600;margin:0 0 8px;padding:4px 8px;background:#fdecea;border:1px solid #f5c6c0;border-radius:6px;display:inline-block}
.answer{display:inline-block;background:#e8f5ec;color:var(--green);font-weight:700;border:1px solid #b7e0c4;border-radius:8px;padding:6px 14px;margin:8px 2px 4px}
.orig-panel{display:none;border:1px solid #e6d28a;border-left:4px solid #d9b310;background:#fffdf5;border-radius:10px;padding:10px 16px}
.qbody.cmp-on .orig-panel{display:block}
.opanel-head{font-size:13px;font-weight:700;color:#8a6d00;letter-spacing:.5px;margin-bottom:6px}
.olabel{font-size:11px;font-weight:700;color:#8693a3;letter-spacing:.5px;margin:10px 0 2px}
.oans{font-size:13px;color:var(--green);font-weight:600;margin:4px 0}
.render.small{font-size:13.5px;color:#444;padding:0}.render.small img{max-width:320px}
.rawcode,.rawall{display:none}
mjx-container{margin:.15em 0!important}
@media(max-width:860px){.qbody.cmp-on{grid-template-columns:1fr}}
footer{max-width:1180px;margin:0 auto;padding:8px 18px 40px;font-size:12px;color:#778}
"""

JS = """
function flash(b){var o=b.textContent;b.textContent='Copied!';b.classList.add('ok');setTimeout(function(){b.textContent=o;b.classList.remove('ok');},1200);}
function copyText(t,b){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){flash(b);}).catch(function(){fb(t,b);});}else fb(t,b);}
function fb(t,b){var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');flash(b);}catch(e){}document.body.removeChild(ta);}
function copyCode(b){copyText(b.closest('.card').querySelector('.rawcode').textContent,b);}
function copyAll(b){copyText(b.closest('.qblock').querySelector('.rawall').textContent,b);}
function toggleCmp(b){var body=b.closest('.qblock').querySelector('.qbody');var on=body.classList.toggle('cmp-on');b.classList.toggle('on',on);b.innerHTML=on?'&#8646; Hide original':'&#8646; Compare with original';}
"""

def build_html(source_name, questions, originals, figdir):
    LET='ABCD'
    from PIL import Image
    def dims(name, maxw):
        p=os.path.join(figdir,name)
        try:
            W,H=Image.open(p).size; w=min(W,maxw); return w,int(H*w/W)
        except Exception:
            return maxw,int(maxw*0.6)
    def img_code(name,maxw):
        w,h=dims(name,maxw); return '<p><img title="%s" src="%s" width="%d" height="%d" /></p>'%(name,name,w,h)
    def img_view(name,maxw):
        p=os.path.join(figdir,name)
        if not os.path.exists(p):
            return '<div class="dnote">&#9888; Missing diagram file: <b>%s</b></div>'%name
        w,h=dims(name,maxw)
        return ('<p><img src="%s" width="%d" height="%d" alt="%s"/></p>'
                '<div class="dnote">&#9888; Diagram file to upload: <b>%s</b></div>'%(_b64(p),w,h,name,name))
    def card(label,view,code):
        return ('<div class="card"><div class="chead"><span class="clabel">%s</span>'
                '<button class="copy" onclick="copyCode(this)">Copy code</button></div>'
                '<div class="render">%s</div><pre class="rawcode" hidden>%s</pre></div>')%(label,view,esc(code))
    blocks=[]
    for i,q in enumerate(questions,1):
        allcode=[]
        qcode=field_html(_parts(q['stem'])); qview=qcode
        if q.get('fig'):
            qcode=qcode+'\n'+img_code(q['fig'],340); qview=qview+img_view(q['fig'],340)
        allcode.append('[QUESTION]\n'+qcode); cards=[card('QUESTION',qview,qcode)]
        for L,opt in zip(LET,q['options']):
            if isinstance(opt,dict) and 'img' in opt:
                ocode=img_code(opt['img'],200); oview=img_view(opt['img'],200)
            else:
                ocode=field_html(_parts(opt)); oview=ocode
            allcode.append('[OPTION %s]\n%s'%(L,ocode)); cards.append(card('OPTION '+L,oview,ocode))
        allcode.append('[ANSWER] (%s)'%q['answer'])
        ansbadge='<div class="answer">ANSWER:&nbsp;(%s)</div>'%q['answer']
        scode=sol_code(_parts(q['solution'])); allcode.append('[SOLUTION]\n'+scode)
        scard=card('SOLUTION',scode,scode)
        main='<div class="main">'+''.join(cards)+ansbadge+scard+'</div>'
        oq,oa,os_=originals.get(i,('','',''))
        orig=('<div class="orig-panel"><div class="opanel-head">ORIGINAL (for comparison)</div>'
              '<div class="olabel">QUESTION</div><div class="render small">%s</div>'
              '<div class="oans">Answer: (%s)</div>'
              '<div class="olabel">SOLUTION</div><div class="render small">%s</div></div>')%(
              oq or '<p><i>(not found)</i></p>', oa, os_ or '<p><i>(not found)</i></p>')
        blocks.append('<section class="qblock"><div class="qhead"><div><span class="qnum">Question %d</span>'
            '<span class="chap">%s</span></div><div class="hbtns">'
            '<button class="cmp" onclick="toggleCmp(this)">&#8646; Compare with original</button>'
            '<button class="copyall" onclick="copyAll(this)">&#9099; Copy entire question</button>'
            '</div></div><pre class="rawall" hidden>%s</pre><div class="qbody">%s%s</div></section>'%(
            i, esc(q.get('chapter','')), esc('\n\n'.join(allcode)), main, orig))
    html=('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<title>%s — Reframed Questions</title>'
        '<script>MathJax={options:{skipHtmlTags:["script","noscript","style","textarea","pre","code"]}};</script>'
        '<script async src="https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-mml-chtml.js"></script>'
        '<style>%s</style></head><body>'
        '<header class="top"><h1>%s &mdash; Reframed Questions (Rendered + Copyable MathML)</h1>'
        '<p>Use <b>Copy code</b> per field or <b>Copy entire question</b>. Click <b>Compare with original</b> to view the original beside the modified question. Red notes show which diagram file (in this folder) to upload.</p></header>'
        '<div class="wrap">%s</div>'
        '<footer>Generated by MCQ Reframer. Plain prose is editable text; only equations are MathML.</footer>'
        '<script>%s</script></body></html>')%(esc(source_name),CSS,esc(source_name),'\n'.join(blocks),JS)
    return html

def write_project(out_root, source_name, html, figdir):
    folder=os.path.join(out_root, source_name)
    os.makedirs(folder, exist_ok=True)
    for f in os.listdir(folder):
        try: os.remove(os.path.join(folder,f))
        except: pass
    with open(os.path.join(folder, source_name+'.html'),'w',encoding='utf-8') as f: f.write(html)
    if os.path.isdir(figdir):
        for fn in os.listdir(figdir):
            shutil.copy(os.path.join(figdir,fn), os.path.join(folder,fn))
    zip_path=os.path.join(out_root, source_name+'.zip')
    if os.path.exists(zip_path):
        try: os.remove(zip_path)
        except: pass
    with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED) as zf:
        for fn in sorted(os.listdir(folder)):
            zf.write(os.path.join(folder,fn), os.path.join(source_name,fn))
    return folder, zip_path
