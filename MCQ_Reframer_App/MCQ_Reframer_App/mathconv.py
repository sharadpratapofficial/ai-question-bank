# -*- coding: utf-8 -*-
"""LaTeX -> editable HTML (variables italic, units roman) and -> MathType MathML.
Parts are tuples ('t', prose) or ('m', latex)."""
import re
from latex2mathml import converter as _l2m

STRUCT = ['\\frac','\\dfrac','\\tfrac','\\sqrt','\\int','\\sum','\\prod','\\begin','\\sin',
          '\\cos','\\tan','\\cot','\\sec','\\csc','\\ln','\\log','\\lim','\\fenced','matrix',
          'cases','\\overline','\\vec','\\hat','\\partial']
def is_struct(latex): return any(t in latex for t in STRUCT)

# ---- unit wrapping: "<number> \, UNIT" -> roman \text{UNIT} with a real space ----
_UNIT=r'(?:mol|rad|min|kg|Pa|Hz|eV|nm|cm|mm|km|[AVWJNCTKms])'
_UEXP=r'(?:\^\{[^}]*\}|\^-?\d+)?'
_USEP=r'(?:\\,|\\;|/)'
_UTOK=_USEP+_UNIT+_UEXP
_URUN=re.compile(r'(?<=[0-9}\)\]])('+_UTOK+r'(?:'+_UTOK+r')*)')
_UONE=re.compile(r'(\\,|\\;|/)('+_UNIT+r')(\^\{[^}]*\}|\^-?\d+)?')
def _wrap_run(m): return _UONE.sub(lambda x:x.group(1)+r'\text{'+x.group(2)+'}'+(x.group(3) or ''), m.group(1))
def wrap_units(s): return _URUN.sub(_wrap_run, s)

_CMD={'Omega':'&Omega;','Delta':'&Delta;','alpha':'&alpha;','beta':'&beta;','gamma':'&gamma;',
 'theta':'&theta;','phi':'&phi;','varphi':'&phi;','omega':'&omega;','mu':'&mu;','rho':'&rho;',
 'sigma':'&sigma;','lambda':'&lambda;','nu':'&nu;','pi':'&pi;','varepsilon':'&epsilon;',
 'epsilon':'&epsilon;','ell':'&#8467;','times':'&times;','cdot':'&middot;','pm':'&plusmn;',
 'approx':'&asymp;','le':'&le;','leq':'&le;','ge':'&ge;','geq':'&ge;','neq':'&ne;','ne':'&ne;',
 'Rightarrow':'&rArr;','rightarrow':'&rarr;','to':'&rarr;','propto':'&prop;','gg':'&#8811;',
 'll':'&#8810;','infty':'&infin;','eta':'&eta;'}
_SKIP={'left','right','displaystyle'}; _SPACEC={',',';',':',' '}

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
def _esc(t): return t.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

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
                elif name in _SKIP: pass
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

def parts_to_html(parts):
    pieces=[]
    for kind,val in parts:
        if kind=='t': pieces.append(_esc(val))
        else: pieces.append(l2ml(val) if is_struct(val) else l2h(val))
    # Insert a space at any part boundary that would otherwise glue two words/numbers
    # together (a model-supplied "t" part missing its trailing/leading space).
    out=[]; prev_last=''
    for piece in pieces:
        first,last=_edge_chars(piece)
        if out and prev_last and first and prev_last.isalnum() and first.isalnum():
            out.append(' ')
        out.append(piece)
        if last: prev_last=last
    return re.sub(r'  +',' ',''.join(out)).strip()
def field_html(parts): return '<p>'+parts_to_html(parts)+'</p>'

_EQ_OP=re.compile(r'=|\\Rightarrow|\\Leftrightarrow|\\implies|\\therefore|\\propto')
def sol_code(lines):
    """Render solution parts as step paragraphs. A real equation ('m' part containing an
    operator like =, \\Rightarrow, \\propto) gets its own <p>; everything else (labels, bare
    variable-name mentions between equations) is grouped with its neighbours into the
    surrounding paragraph, using the same spacing rules as parts_to_html — so a model that
    narrates a sentence with an inline variable reference doesn't get shattered into one <p>
    per word/symbol."""
    steps=[]; buf=[]
    for part in lines:
        kind,val=part
        if kind=='m' and _EQ_OP.search(val):
            if buf:
                steps.append(parts_to_html(buf)); buf=[]
            steps.append(parts_to_html([part]))
        else:
            buf.append(part)
    if buf:
        steps.append(parts_to_html(buf))
    return '\n'.join('<p>'+s+'</p>' for s in steps if s.strip())
