# -*- coding: utf-8 -*-
"""LaTeX -> editable HTML (variables italic, units roman) and -> MathType MathML.
Parts are tuples ('t', prose) or ('m', latex)."""
import re
from latex2mathml import converter as _l2m
from logsetup import get_logger
_mlog = get_logger("mathconv")

STRUCT = ['\\frac','\\dfrac','\\tfrac','\\sqrt','\\int','\\sum','\\prod','\\begin','\\sin',
          '\\cos','\\tan','\\cot','\\sec','\\csc','\\ln','\\log','\\lim','\\fenced','matrix',
          'cases','\\overline','\\vec','\\hat','\\partial']
def is_struct(latex): return any(t in latex for t in STRUCT)

# ---- unit wrapping: "<number> UNIT" -> roman \text{UNIT} ----
# Units are set upright, variables italic — that's the convention, and _core()
# italicises every bare letter, so any unit it sees unwrapped comes out wrong
# ("3 <i>m</i> <i>s</i>⁻¹" instead of "3 m s⁻¹").
#
# The separator between the number and the unit may be a LaTeX thin space
# (\, \; \ ), a slash, or — by far the most common in model output and the case
# this originally missed entirely — an ordinary space. "3 m\,s^{-1}" failed
# because its first unit is space-separated, so the whole run went unwrapped
# (2026-08-30 bug report).
_UNIT=r'(?:mol|rad|min|kg|Pa|Hz|eV|nm|cm|mm|km|[AVWJNCTKms])'
_UEXP=r'(?:\^\{[^}]*\}|\^-?\d+)?'
_USEP=r'(?:\\[,;: ]|/|\s+)'
# A unit must not run into a longer word ("10 minutes" is not 10 min + "utes",
# "3 mass" is not 3 m + "ass"), hence the trailing letter guard.
_UTOK=_USEP+_UNIT+_UEXP+r'(?![A-Za-z])'
_URUN=re.compile(r'(?<=[0-9}\)\]])((?:'+_UTOK+r')+)')
_UONE=re.compile(r'('+_USEP+r')('+_UNIT+r')(\^\{[^}]*\}|\^-?\d+)?(?![A-Za-z])')
def _wrap_run(m): return _UONE.sub(lambda x:x.group(1)+r'\text{'+x.group(2)+'}'+(x.group(3) or ''), m.group(1))
def wrap_units(s): return _URUN.sub(_wrap_run, s)

_CMD={'Omega':'&Omega;','Delta':'&Delta;','alpha':'&alpha;','beta':'&beta;','gamma':'&gamma;',
 'theta':'&theta;','phi':'&phi;','varphi':'&phi;','omega':'&omega;','mu':'&mu;','rho':'&rho;',
 'sigma':'&sigma;','lambda':'&lambda;','nu':'&nu;','pi':'&pi;','varepsilon':'&epsilon;',
 'epsilon':'&epsilon;','ell':'&#8467;','times':'&times;','cdot':'&middot;','pm':'&plusmn;',
 'approx':'&asymp;','le':'&le;','leq':'&le;','ge':'&ge;','geq':'&ge;','neq':'&ne;','ne':'&ne;',
 'Rightarrow':'&rArr;','rightarrow':'&rarr;','to':'&rarr;','propto':'&prop;','gg':'&#8811;',
 'll':'&#8810;','infty':'&infin;','eta':'&eta;',
 # These three are already recognised by _EQ_OP (sol_code's step-boundary
 # detector) as real equation operators, but were missing here — so a model
 # that wrote "\implies" got the bare literal word "implies" printed instead
 # of the arrow (2026-07-24 bug report). Same glyphs as their close cousins
 # already above (Rightarrow/looks-like "=>").
 'implies':'&rArr;','Leftrightarrow':'&hArr;','therefore':'&there4;',
 # Only Omega and Delta were here, so every other capital Greek letter reached
 # the reader as its bare command name — "\Phi_{net}" rendered as "Phi_net"
 # (2026-08-19 bug report: flux symbols in modified solutions).
 'Phi':'&Phi;','Psi':'&Psi;','Sigma':'&Sigma;','Theta':'&Theta;','Lambda':'&Lambda;',
 'Gamma':'&Gamma;','Pi':'&Pi;','Xi':'&Xi;','Upsilon':'&Upsilon;',
 'psi':'&psi;','tau':'&tau;','xi':'&xi;','zeta':'&zeta;','kappa':'&kappa;',
 'chi':'&chi;','delta':'&delta;','iota':'&iota;','upsilon':'&upsilon;',
 'partial':'&part;','nabla':'&nabla;','angle':'&ang;','perp':'&perp;',
 'parallel':'&par;','cdots':'&ctdot;','ldots':'&hellip;','dots':'&hellip;',
 'mp':'&#8723;','equiv':'&equiv;','sim':'&sim;','simeq':'&#8771;','degree':'&deg;',
 'circ':'&deg;','prime':'&prime;','hbar':'&#8463;','forall':'&forall;','exists':'&exist;'}
_SKIP={'left','right','displaystyle'}; _SPACEC={',',';',':',' '}
# Multi-letter LaTeX spacing commands (as opposed to the single-punctuation
# ones in _SPACEC, e.g. \, \; \:) — \quad/\qquad are extremely common in
# model-authored solutions to separate several results on one line (e.g.
# "[A]=[L^2], \quad [T]=[K]"). Without this, _core()'s generic "unknown
# command" fallback below prints the bare command NAME as literal text — the
# question rendered with a stray visible "quad" (2026-07-22 bug report).
_SPACE_CMDS={'quad':'&emsp;','qquad':'&emsp;&emsp;','enspace':'&ensp;',
 'thinspace':'&#8201;','negthinspace':'','medspace':'&#8197;','thickspace':'&emsp;'}

def _readgroup(s,i):
    d=0;j=i
    while j<len(s):
        if s[j]=='{':d+=1
        elif s[j]=='}':
            d-=1
            if d==0:return s[i+1:j],j+1
        j+=1
    return s[i+1:],len(s)
def _readarg(s,i):
    if i<len(s) and s[i]=='{':return _readgroup(s,i)
    if i<len(s) and s[i]=='\\':
        m=re.match(r'\\[a-zA-Z]+',s[i:])
        if m:return m.group(0),i+len(m.group(0))
    if i<len(s):return s[i],i+1
    return '',i
def _esc(t):
    # A literal "\n" surviving into a single-<p> field (stems/options) is a leftover
    # step boundary sol_code() didn't consume; render it as a plain space rather than
    # letting a raw newline sit inside the HTML text.
    return t.replace('\n',' ').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

# Blackboard-bold number sets — \mathbb{R} is ℝ, the reals. Anything outside
# this table keeps its plain letter, which still reads correctly.
_BLACKBOARD={'R':'&#8477;','N':'&#8469;','Z':'&#8484;','Q':'&#8474;','C':'&#8450;',
             'H':'&#8461;','P':'&#8473;','E':'&#8455;','F':'&#120125;'}
def _blackboard(a):
    return "".join(_BLACKBOARD.get(ch,_esc(ch)) for ch in (a or ""))

def _core(s):
    out=[];i=0;n=len(s)
    while i<n:
        c=s[i]
        if c=='\\':
            nxt=s[i+1] if i+1<n else ''
            if nxt in _SPACEC: out.append(' ');i+=2;continue
            if nxt=='!': i+=2;continue
            m=re.match(r'\\([a-zA-Z]+)',s[i:])
            if m:
                name=m.group(1);i+=1+len(name)
                if name in ('text','mathrm','mathbf','operatorname','mathit'):
                    a,i=_readarg(s,i);out.append(_esc(a))
                elif name=='mathbb':
                    # Number sets: \mathbb{R} is ℝ. Without this the generic
                    # "unknown command" fallback below printed the command NAME,
                    # so a question read "for all θ in mathbbR" (2026-08-18 bug
                    # report) — meaningless to a student.
                    a,i=_readarg(s,i);out.append(_blackboard(a))
                elif name in ('mathcal','mathfrak','mathscr','mathsf','mathtt','boldsymbol','bm'):
                    # Other font switches carry no meaning we can render — emit
                    # the ARGUMENT, never the command name.
                    a,i=_readarg(s,i);out.append(_esc(a))
                elif name in ('frac','dfrac','tfrac'):
                    # l2h() is only ever reached when l2ml() (the real MathML
                    # renderer) fails on this equation — but \frac is one of
                    # the STRUCT tokens that routed it here in the first
                    # place, so it's near-certain to appear. Left to the
                    # generic fallback below, the two {..}{..} argument
                    # groups get silently glued together with no separator
                    # at all (e.g. "\frac{P_2}{P_1}" -> literal "frac" then
                    # P2 then P1, unreadable) — render a proper inline
                    # numerator-over-denominator instead (2026-07-24 bug
                    # report: solutions showing raw "frac...P2P1" text).
                    a,i=_readarg(s,i);b,i=_readarg(s,i)
                    out.append('<sup>'+_core(a)+'</sup>⁄<sub>'+_core(b)+'</sub>')
                elif name in _ACCENTS:
                    # \hat{n} -> n̂ : the accent is a combining character placed
                    # AFTER the letter it sits on.
                    a,i=_readarg(s,i);out.append(_core(a)+_ACCENTS[name])
                elif name in _SKIP: pass
                elif name in _SPACE_CMDS: out.append(_SPACE_CMDS[name])
                elif name in _CMD: out.append(_CMD[name])
                else: out.append(_esc(name))
            else: i+=1
        elif c=='^':
            g,i=_readarg(s,i+1)
            if g in ('\\circ','\\degree'): out.append('&deg;')
            else: out.append('<sup>'+_core(g)+'</sup>')
        elif c=='_':
            g,i=_readarg(s,i+1);out.append('<sub>'+_core(g)+'</sub>')
        elif c=='{':
            g,i=_readgroup(s,i);out.append(_core(g))
        elif c=='}': i+=1
        elif c=='-': out.append('&minus;');i+=1
        elif c.isalpha(): out.append('<i>'+c+'</i>');i+=1
        else: out.append(c);i+=1
    return ''.join(out)
def l2h(s): return _core(wrap_units(s))

# ---- LaTeX -> MathML (team reference encoding) ----
_NAMED={0x2212:'&minus;',0xD7:'&times;',0xB7:'&sdot;',0xA0:'&#160;',0x2009:'&#8201;',
 0x3B1:'&alpha;',0x3B2:'&beta;',0x3B3:'&gamma;',0x394:'&Delta;',0x3B4:'&delta;',0x3B8:'&theta;',
 0x3C0:'&pi;',0x3BC:'&mu;',0x3C1:'&rho;',0x3BB:'&lambda;',0x3BD:'&nu;',0x3C3:'&sigma;',
 0x3B5:'&epsilon;',0x3A9:'&Omega;',0x3C9:'&omega;',0x3D5:'&phi;',0x3C6:'&phi;',0x221E:'&infin;',
 0x2202:'&part;',0x222B:'&int;',0x21D2:'&rArr;',0x2192:'&rarr;',0x2032:'&prime;',0x2218:'&deg;',
 0x2208:'&isin;',0x2264:'&le;',0x2265:'&ge;',0x2260:'&ne;',0x221A:'&radic;',0x2061:''}
def _fix_ref(m):
    cp=int(m.group(1),16)
    if cp in _NAMED: return _NAMED[cp]
    if 32<=cp<127:
        if cp==38:return '&amp;'
        if cp==60:return '&lt;'
        if cp==62:return '&gt;'
        return chr(cp)
    return '&#%d;'%cp
def fix_mathml(ml):
    ml=ml.replace(' display="inline"','').replace(' display="block"','')
    ml=re.sub(r'(<math[^>]*>)\s*<mrow>(.*)</mrow>\s*</math>\s*$',r'\1\2</math>',ml,flags=re.S)
    return re.sub(r'&#x([0-9A-Fa-f]+);',_fix_ref,ml)
def l2ml(latex):
    pre=wrap_units(latex).replace(r'\dfrac',r'\frac').replace(r'\tfrac',r'\frac').replace(r'\displaystyle','')
    pre=pre.replace(r'\,','\\ ').replace(r'\;','\\ ').replace(r'\:','\\ ').replace(r'\!','')
    return fix_mathml(_l2m.convert(pre).strip())

# MathType-flavoured LaTeX constructs that latex2mathml can't parse — normalise the
# common ones before a retry (\mathop{..}\limits^, \left. dangling delimiters, stray
# spacing groups from the MathType translator).
_MT_CLEAN=[(re.compile(r'\\limits\b'),''),(re.compile(r'\\mathop\b'),''),
           (re.compile(r'\\text\{\\?[;,!]\s*\}'),' '),(re.compile(r'\{\\[;,!]\s*'),'{'),
           (re.compile(r'\\left\.'),''),(re.compile(r'\\right\.'),''),
           (re.compile(r'\\lower\s*\{[^}]*\}'),''),(re.compile(r'\\raise\s*\{[^}]*\}'),'')]
def _mt_cleanup(latex):
    s=latex
    for rx,rep in _MT_CLEAN: s=rx.sub(rep,s)
    return s

def l2ml_safe(latex):
    """l2ml that NEVER raises: retry after cleaning MathType quirks, then fall back to
    the lightweight HTML renderer — one unparseable equation must not crash a build
    (it previously killed whole ingestion runs from inside build_html)."""
    try:
        return l2ml(latex)
    except Exception:
        pass
    try:
        return l2ml(_mt_cleanup(latex))
    except Exception:
        _mlog.warning("latex->MathML failed; falling back to HTML: %r", latex[:150])
    try:
        return l2h(latex)
    except Exception:
        return _esc(latex)

# Apply fix_mathml to every <math>...</math> block inside an HTML fragment (e.g. the
# pandoc-generated MathML in the original/extracted questions), making it MathType-compatible.
_MATH_BLOCK=re.compile(r'<math\b.*?</math>',re.S|re.I)
def fix_mathml_in_html(html):
    if not html: return html
    return _MATH_BLOCK.sub(lambda m:fix_mathml(m.group(0)), html)

_TAG=re.compile(r'<[^>]+>')
def _edge_chars(html):
    t=_TAG.sub('',html)
    return (t[0] if t else ''),(t[-1] if t else '')

_LATEX_HINT=re.compile(r'\\[a-zA-Z]+|\\[,;:!]|\^\{|_\{|\^-?\w|_-?\w')
_TEXT_CMD_RE=re.compile(r'\\(?:text|mathrm|mathbf|mathit|operatorname|mathcal|mathfrak|mathscr|mathsf|mathtt|boldsymbol|bm)\{([^{}]*)\}')
_MATHBB_RE=re.compile(r'\\mathbb\{([^{}]*)\}')
_FRAC_RE=re.compile(r'\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}')
_NAMED_CMD_RE=re.compile(r'\\([a-zA-Z]+)')
# \vec{E}, \hat{n}, \bar{x}… in a PROSE part had no handler at all, so options
# showed the literal "\vec{E}" (2026-08-19 bug report). Rendered with combining
# marks, which need no MathML and survive copy/paste.
_ACCENTS={'vec':'&#8407;','hat':'&#770;','bar':'&#772;','overline':'&#772;',
          'tilde':'&#771;','dot':'&#775;','ddot':'&#776;','check':'&#780;',
          # \widehat{i} is how unit vectors are written in these papers; without
          # it the reader saw the literal "uwidehati" (2026-09-08 report).
          'widehat':'&#770;','widetilde':'&#771;','widebar':'&#772;',
          'overrightarrow':'&#8407;','overarc':'&#785;','mathring':'&#778;'}
_ACCENT_RE=re.compile(
    r'\\(overrightarrow|widehat|widetilde|widebar|mathring|overarc|vec|hat|bar|overline'
    r'|tilde|ddot|dot|check)\{([^{}]*)\}')
# A capitalised Greek NAME written without its backslash but used as a variable
# ("Phi_net = ...") — unambiguous immediately before a subscript, and common
# enough in model output to be worth rescuing.
_BARE_GREEK_RE=re.compile(
    r'(?<!\\)\b(Phi|Psi|Sigma|Theta|Lambda|Gamma|Omega|Delta|Upsilon|Xi)_(?:\{([^{}]*)\}|([A-Za-z0-9]+))')

def _delatex_text(t):
    """Render LaTeX that leaked into a {"t"} PROSE part.

    Text parts are escaped, never parsed, so a model that writes a unit as
    "8 m\\,s^{-2}" instead of putting it in an {"m"} part reaches the reader
    with the markup showing (2026-08-17 bug report; 9% of modified questions).
    This converts the constructs that actually turn up in prose — spacing
    commands, sub/superscripts, \\text{}, \\frac{}{} and named symbols — and
    leaves everything else alone.

    Deliberately NOT l2h(): that treats its input as pure math and italicises
    every single letter, which would mangle the surrounding sentence."""
    s=_esc(t)
    if not _LATEX_HINT.search(s): return s
    s=re.sub(r'\\[,;:!]',' ',s)                      # thin/med spaces -> real space
    s=_MATHBB_RE.sub(lambda m:_blackboard(m.group(1)),s)   # \mathbb{R} -> ℝ
    s=_ACCENT_RE.sub(lambda m:m.group(2)+_ACCENTS[m.group(1)],s)  # \vec{E} -> E⃗
    # Prose-style "Phi_net" subscripts the whole word, unlike LaTeX's
    # "\Phi_net" where only the first character would be.
    s=_BARE_GREEK_RE.sub(
        lambda m:_CMD[m.group(1)]+'<sub>'+(m.group(2) or m.group(3))+'</sub>',s)
    s=_TEXT_CMD_RE.sub(r'\1',s)                       # \text{N} -> N
    s=_FRAC_RE.sub(r'<sup>\1</sup>&frasl;<sub>\2</sub>',s)
    s=re.sub(r'\^\{([^{}]*)\}',r'<sup>\1</sup>',s)    # ^{-2} -> <sup>-2</sup>
    s=re.sub(r'_\{([^{}]*)\}',r'<sub>\1</sub>',s)
    s=re.sub(r'\^(-?\w)',r'<sup>\1</sup>',s)          # ^2 (unbraced)
    s=re.sub(r'_(-?\w)',r'<sub>\1</sub>',s)
    s=re.sub(r'\\(?:left|right)\b','',s)
    # Named symbols (\Omega, \pi, \times…) via the same table the math path
    # uses; anything unrecognised is left verbatim rather than silently cut.
    s=re.sub(r'\\([a-zA-Z]+)',
             lambda m:_SPACE_CMDS.get(m.group(1), m.group(0)), s)  # \quad -> wide space
    s=_NAMED_CMD_RE.sub(_named_symbol,s)
    return s

def _named_symbol(m):
    """\\Omega -> &Omega;. The [a-zA-Z]+ match is greedy, so a command written
    without a separator glues the next word on ("\\Deltat" for Δt) — fall back
    to the longest known prefix and keep the remainder as text. Unknown
    commands are returned untouched, never dropped."""
    name=m.group(1)
    if name in _CMD: return _CMD[name]
    for i in range(len(name)-1,1,-1):
        if name[:i] in _CMD: return _CMD[name[:i]]+name[i:]
    return m.group(0)

# --------------------------------------------------------------------------- #
#  markdown + delimited maths inside a PROSE part
# --------------------------------------------------------------------------- #
# The extractors read a paper that pandoc turned into MARKDOWN, so the model's
# prose parts arrive carrying markdown's own notation: "$u^2 + (2u-gt)^2 = 2u^2$"
# for an equation and "**Recognition Cue:**" for a bold label. Escaped and
# printed verbatim — which is all a "t" part used to get — those reach QBG as
# literal dollar signs and asterisks, and the reader sees the markup instead of
# the maths (2026-09-08 report, HTML and Word alike).
#
# So a prose part is split before it is escaped: the maths is handed to the real
# renderer, the emphasis becomes real tags, and only genuine prose goes through
# _delatex_text.
_MATH_SPAN = re.compile(
    r'\$\$(?P<dd>.+?)\$\$'                 # $$ … $$
    r'|(?<![\\$])\$(?P<d>[^$\n]+?)\$(?!\$)'  # $ … $   (not \$ or $$)
    r'|\\\((?P<paren>.+?)\\\)'             # \( … \)
    r'|\\\[(?P<brack>.+?)\\\]',            # \[ … \]
    re.S)

# A bare LaTeX command WITH braces, plus whatever it is glued to:
# "\widehat{i}", "\sqrt{2}u", "\frac{a}{b}". Requiring the braces keeps this
# away from prose that merely contains a backslash, and away from the spacing
# commands (\, \;) _delatex_text already handles.
_BARE_MATH = re.compile(r'(?:\\[a-zA-Z]+(?:\{[^{}]*\})+)+[A-Za-z0-9]*')

_MD_BOLD = re.compile(r'\*\*(?!\s)(.+?)(?<!\s)\*\*', re.S)
_MD_ITALIC = re.compile(r'(?<![\*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\*\w])')


def _render_math(latex):
    """One extracted equation, through the same renderer an {"m"} part uses."""
    latex = (latex or "").strip()
    if not latex:
        return ""
    return l2ml_safe(latex) if is_struct(latex) else l2h(latex)


def _md_emphasis(html):
    """Markdown emphasis -> real tags, applied to already-escaped prose.

    <b>/<i> rather than <strong>/<em>: QBG's sanitiser keeps the legacy pair
    (same reason html_ingest.py rewrites them)."""
    if "*" not in html:
        return html
    html = _MD_BOLD.sub(r'<b>\1</b>', html)
    html = _MD_ITALIC.sub(r'<i>\1</i>', html)
    return html


def prose_to_html(t):
    """A {"t"} part as HTML: its maths rendered, its emphasis real, its text escaped."""
    text = t or ""
    if not text:
        return ""
    out = []
    pos = 0
    for m in _MATH_SPAN.finditer(text):
        out.append(("text", text[pos:m.start()]))
        out.append(("math", m.group("dd") or m.group("d") or m.group("paren") or m.group("brack")))
        pos = m.end()
    out.append(("text", text[pos:]))

    pieces = []
    for kind, seg in out:
        if kind == "math":
            pieces.append(_render_math(seg))
            continue
        # Bare "\cmd{…}" runs inside the prose are maths too.
        last = 0
        for bm in _BARE_MATH.finditer(seg):
            pieces.append(_md_emphasis(_delatex_text(seg[last:bm.start()])))
            pieces.append(_render_math(bm.group(0)))
            last = bm.end()
        pieces.append(_md_emphasis(_delatex_text(seg[last:])))
    return "".join(pieces)


def parts_to_html(parts):
    pieces=[]
    for kind,val in parts:
        if kind=='t': pieces.append(prose_to_html(val))
        # 'h' = markup that is already what we want to emit. The HTML ingestion
        # path (html_ingest.py) reads papers whose MathML QBG already accepts, so
        # sending it through LaTeX and back would only lose it.
        elif kind=='h': pieces.append(val)
        else: pieces.append(l2ml_safe(val) if is_struct(val) else l2h(val))
    # Insert a space at any part boundary that would otherwise glue two words/numbers
    # together (a model-supplied "t" part missing its trailing/leading space).
    # Clause punctuation counts too: an inline equation following prose that ends
    # in "," or "." ("From the figure," + "x(0)=0") needs the space just as much as
    # two words do — it only never showed before because such equations were being
    # split onto their own line (see sol_code).
    out=[]; prev_last=''
    for piece in pieces:
        first,last=_edge_chars(piece)
        if out and prev_last and first and first.isalnum() and (
                prev_last.isalnum() or prev_last in ',;:.!?'):
            out.append(' ')
        out.append(piece)
        if last: prev_last=last
    return re.sub(r'  +',' ',''.join(out)).strip()
def field_html(parts): return '<p>'+parts_to_html(parts)+'</p>'

_EQ_OP=re.compile(r'=|\\Rightarrow|\\Leftrightarrow|\\implies|\\therefore|\\propto')
# A step that's nothing but a comma/period/semicolon etc (with no letters or
# digits) is leftover punctuation that sat between two equations in the
# source — e.g. "m/k = 1/pi^2" <comma> "g = 10" each independently trigger
# their own step, stranding the comma alone in between. Glue it onto the
# previous step instead of giving it its own paragraph (2026-07-15 bug: values
# lists like "m/k = ..., g = 10, a = 5, theta = 30." were rendering with each
# comma/the trailing period on its own line).
_PUNCT_ONLY_STEP=re.compile(r'^[\s,;:.–—…]*$')
def _append_step(steps, html):
    if not html.strip():
        return
    if steps and _PUNCT_ONLY_STEP.match(_TAG.sub('', html)):
        steps[-1] = steps[-1] + html
    else:
        steps.append(html)

def _flush_buf(buf, steps):
    """Emit `buf` as one or more <p>-worthy step strings: a 't' part carrying an
    embedded "\\n" (a source line/paragraph break patterns.py preserved — see
    patterns._norm_ws) starts a NEW step at that point, same as hitting an equation."""
    sub=[]
    for kind,val in buf:
        if kind=='t' and '\n' in val:
            segs=val.split('\n')
            for i,seg in enumerate(segs):
                if i>0:
                    if sub: _append_step(steps, parts_to_html(sub))
                    sub=[]
                if seg:
                    sub.append(('t',seg))
        else:
            sub.append((kind,val))
    if sub:
        _append_step(steps, parts_to_html(sub))
    buf.clear()

# ---- inline vs display equations -------------------------------------------
# An equation gets its own <p> only when it stands alone. When the prose that
# FOLLOWS it continues the same sentence, it was inline in the source document
# and must stay in the flowing paragraph. Extractors hand us a flat part list
# with no display/inline flag (the AI returns {"t":..}/{"m":..} only), so the
# following prose is the evidence we have:
#
#   "From the figure," <x(0)=0> <x(1)=7 m> "and" <x(2)=12 m> ". Hence"
#
# used to render as SIX separate lines — a sentence shattered mid-flow
# (2026-08-27 bug report, QBG Ingestion). Both trailing fragments here ("and",
# ". Hence") can only be continuations, never the start of a new step.
#
# Deliberately narrow: only leading clause punctuation or a closed set of
# conjunctions/prepositions counts. Anything else — a capitalised new sentence
# ("Therefore,"), or any other lower-case lead-in ("which give") — keeps the
# long-standing display behaviour, so a genuine display equation is never
# swallowed into the prose around it.
_INLINE_LEAD=re.compile(r'^[\s]*[,;:.!?)\]]')
_LEAD_WORD=re.compile(r'^\s*([a-z]+)\b')
_CONNECTORS={'and','or','but','nor','so','then','with','where','while','plus',
             'into','from','of','for','at','in','on','to','as',
             # Bridges that can only follow the equation they refer back to.
             # An elaborated solution uses them constantly ("… = 36 hence k² = 9/64"),
             # and without them each one was stranded on a line of its own.
             'hence','thus','gives','giving','yielding','leaving'}

def _continues_sentence(part):
    """True when this prose part can only be a continuation of the sentence the
    preceding equation sits in — i.e. that equation was inline, not display."""
    if not part or part[0]!='t':
        return False
    val=part[1] or ''
    if not val.strip():
        return False
    # A preserved source line break means the equation ended its line -> display.
    if val.lstrip(' \t').startswith('\n'):
        return False
    if _INLINE_LEAD.match(val):
        return True
    m=_LEAD_WORD.match(val)
    return bool(m and m.group(1) in _CONNECTORS)

# A solution written in the RankUp house style is a sequence of LABELLED lines —
# "Effective Approach", then "Recognition Cue:", "Micro Concept:", and so on. The
# extractor flattens that into prose parts with no line breaks in them, so the
# whole solution arrived in QBG as one unbroken paragraph (2026-09-08 report).
# The labels themselves say where the lines were, so the breaks are put back from
# them rather than relying on the model to emit newlines it usually drops.
_SECTION_HEADS = (
    "Effective Approach", "Detailed Solution", "Wrong Answer Analysis",
    "Domain and Consistency Checks", "Physical and Consistency Checks",
    "Common Incorrect-Entry Analysis", "Consistency Checks",
)
_SECTION_RE = re.compile(
    r'(?<!\n)(?<!\*)\s*(' + '|'.join(re.escape(h) for h in _SECTION_HEADS) + r')\b:?')

# The labels this house style opens its lines with. They are bolded HERE rather
# than trusting the extractor to have kept the source's "**…**": it often drops
# the asterisks, and then every label ran on inside the paragraph (2026-09-08
# report, Word ingestion). A fixed list, because inventing bold from any
# "Something:" would embolden ordinary sentences.
# Labels that OPEN a line in the source, so each starts a new one here.
_LABEL_WORDS = (
    "Recognition Cue", "Micro Concept", "Macro Concept / Linkage", "Macro Concept",
    "Macro Linkage", "Fast Route", "Checkpoint", "Key Idea", "Ideal Time",
    "Verified Correct Answer",
)
# Labels that CONTINUE one — "Option (D): Mistake Tag: Concept Gap." is a single
# line in the source, so these are bolded where they stand and nothing is split.
_INLINE_LABEL_WORDS = ("Mistake Tag", "Named Trap", "Common Trap")

_LABEL_RE = re.compile(
    # A bullet marker in front belongs to the label's line, not to the one before it.
    r'(?<!\*)(?<!\w)(?:[-*\u2022]\s*)?('
    + '|'.join(re.escape(w) for w in _LABEL_WORDS)
    + r'|Option\s*\([A-Da-d]\))\s*:',
    re.I)
_INLINE_LABEL_RE = re.compile(
    r'(?<!\*)(?<!\w)(' + '|'.join(re.escape(w) for w in _INLINE_LABEL_WORDS) + r')\s*:',
    re.I)

# "**Recognition Cue:**" — a short bold run, which in this house style always
# opens a line. Long bold runs are emphasis inside a sentence, not a label.
_BOLD_LABEL_RE = re.compile(r'(?<!\n)\s*(\*\*[^*\n]{2,60}?\*\*)')


def _restore_line_breaks(val):
    """Insert the newlines a labelled solution lost, so _flush_buf makes steps."""
    if not val:
        return val
    # The source prints these as headings, so they get their own bold line.
    out = _SECTION_RE.sub(lambda m: "\n**" + m.group(1) + "**\n", val)
    # An un-bolded house label becomes a bold one; the opening ones start a line.
    out = _LABEL_RE.sub(lambda m: "\n**" + m.group(1) + ":**", out)
    out = _INLINE_LABEL_RE.sub(lambda m: "**" + m.group(1) + ":**", out)

    def _break_bold(m):
        """A bold run opens a line — unless it is one of the labels that
        continues one ("Option (D): Mistake Tag: …" is a single line)."""
        inner = m.group(1).strip("*")
        if _INLINE_LABEL_RE.match(inner):
            return m.group(0)
        return "\n" + m.group(1)

    out = _BOLD_LABEL_RE.sub(_break_bold, out)
    out = re.sub(r'\n{2,}', '\n', out)
    # NOT lstrip'd: a heading at the very start of this part still has to end the
    # step the PREVIOUS part was building, or it glues onto the end of that line
    # ("…perpendicular to velocity. Detailed Solution").
    return out if out.strip() else val


def sol_code(lines):
    """Render solution parts as step paragraphs. A real equation ('m' part containing an
    operator like =, \\Rightarrow, \\propto) gets its own <p> UNLESS the prose right
    after it continues the sentence it sits in (see _continues_sentence), in which case
    it stays inline — matching how the source Word file laid it out. A source
    line/paragraph break preserved inside a 't' part also starts a new <p> (see
    _flush_buf); everything else (labels, bare variable-name mentions between equations)
    is grouped with its neighbours into the surrounding paragraph, using the same spacing
    rules as parts_to_html — so a model that narrates a sentence with an inline variable
    reference doesn't get shattered into one <p> per word/symbol."""
    steps=[]; buf=[]
    parts=[('t', _restore_line_breaks(p[1])) if p[0]=='t' else tuple(p)
           for p in (tuple(x) for x in lines)]
    n=len(parts); i=0
    while i<n:
        kind,val=parts[i]
        if kind=='m' and _EQ_OP.search(val):
            # Take the whole run of back-to-back equations: the prose after the
            # run decides for all of them, since "<eq> <eq> and <eq>" is one
            # sentence, not three steps.
            j=i
            while j<n and parts[j][0]=='m' and _EQ_OP.search(parts[j][1]):
                j+=1
            if _continues_sentence(parts[j] if j<n else None):
                buf.extend(parts[i:j])
            else:
                _flush_buf(buf, steps)
                for p in parts[i:j]:
                    steps.append(parts_to_html([p]))
            i=j
        else:
            buf.append(parts[i]); i+=1
    _flush_buf(buf, steps)
    # Solution steps are short statements ("Flux through the x-faces:"), and the
    # QBG viewer justifies paragraph text — which stretches a three-word line
    # across the full column. The question keeps the platform's justification;
    # only these step lines opt out (2026-08-19 bug report).
    return '\n'.join('<p style="text-align:left">'+s+'</p>' for s in steps if s.strip())
