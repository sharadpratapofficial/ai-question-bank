# -*- coding: utf-8 -*-
"""MathType equation extraction — the 0%-error path for docx files whose equations are
MathType OLE objects (ProgID Equation.DSMT4 / Equation.3).

pandoc cannot read MathType OLE objects; it exports only their WMF preview images, so
questions arrive with "image3.wmf" placeholders instead of math. This module converts
the equations DETERMINISTICALLY using MathType's own engine:

    docx zip -> word/embeddings/oleObjectN.bin -> "Equation Native" stream -> MTEF v5
        -> MT6.dll MTXFormEqn (MathType SDK, translator "AMS LaTeX.tdl") -> LaTeX

and maps each equation to its WMF preview filename (via document.xml + rels), so the
pandoc markdown's image references can be swapped for real $latex$ math.

Requires MathType to be installed (MT6.dll). When it isn't, everything no-ops and the
pipeline behaves exactly as before (images stay images).
"""
import os
import re
import struct
import zipfile
import xml.etree.ElementTree as ET

from logsetup import get_logger

log = get_logger("mtef")

_MT6_CANDIDATES = [
    os.environ.get("QBG_MT6_DLL", "").strip(),
    r"C:\Program Files (x86)\MathType\System\64\MT6.dll",
    r"C:\Program Files\MathType\System\64\MT6.dll",
]

# MathType SDK constants (MTXFormEqn)
_mtxfmLOCAL = -3
_mtxfmMTEF = 4
_mtxfmTEXT = 7

_NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "o": "urn:schemas-microsoft-com:office:office",
    "v": "urn:schemas-microsoft-com:vml",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}

_EQ_PROGID = re.compile(r"^Equation\.", re.I)


def mt6_path():
    for p in _MT6_CANDIDATES:
        if p and os.path.exists(p):
            return p
    return None


def available():
    return mt6_path() is not None


def _read_mtef(ole_bytes):
    """Pull the raw MTEF blob out of an OLE compound file's 'Equation Native' stream."""
    import io
    import olefile
    ole = olefile.OleFileIO(io.BytesIO(ole_bytes))
    try:
        if not ole.exists("Equation Native"):
            return None
        data = ole.openstream("Equation Native").read()
    finally:
        ole.close()
    if len(data) < 30:
        return None
    hdr = struct.unpack_from("<H", data, 0)[0]  # EQNOLEFILEHDR size (28)
    if hdr <= 0 or hdr >= len(data):
        return None
    return data[hdr:]


class _MT6:
    """Thin ctypes wrapper around the MathType SDK, one connect per batch."""

    def __init__(self, dll_path):
        import ctypes
        self.ct = ctypes
        self.mt = ctypes.WinDLL(dll_path)

        class RECT(ctypes.Structure):
            _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long),
                        ("r", ctypes.c_long), ("b", ctypes.c_long)]

        class DIMS(ctypes.Structure):
            _fields_ = [("baseline", ctypes.c_int), ("bounds", RECT)]

        self.DIMS = DIMS
        self.mt.MTXFormEqn.argtypes = [
            ctypes.c_short, ctypes.c_short, ctypes.c_char_p, ctypes.c_int,
            ctypes.c_short, ctypes.c_short, ctypes.c_char_p, ctypes.c_int,
            ctypes.c_char_p, ctypes.POINTER(DIMS)]
        self.mt.MTXFormEqn.restype = ctypes.c_int
        r = self.mt.MTAPIConnect(1, 30)
        if r != 0:
            raise RuntimeError("MTAPIConnect failed: %d" % r)

    def set_translator(self, tdl_name):
        self.mt.MTXFormReset()
        r = self.mt.MTXFormSetTranslator(0, tdl_name.encode())
        if r != 0:
            raise RuntimeError("MTXFormSetTranslator(%s) failed: %d" % (tdl_name, r))

    def mtef_to_text(self, mtef):
        out = self.ct.create_string_buffer(131072)
        path = self.ct.create_string_buffer(1024)
        dims = self.DIMS()
        r = self.mt.MTXFormEqn(_mtxfmLOCAL, _mtxfmMTEF, mtef, len(mtef),
                               _mtxfmLOCAL, _mtxfmTEXT, out, len(out), path,
                               self.ct.byref(dims))
        if r != 0:
            raise RuntimeError("MTXFormEqn failed: %d" % r)
        return out.value.decode("utf-8", "replace")

    def close(self):
        try:
            self.mt.MTAPIDisconnect()
        except Exception:
            pass


_DELIMS = (("\\[", "\\]"), ("$$", "$$"), ("\\(", "\\)"), ("$", "$"))


def _strip_delims(tex):
    t = tex.strip()
    for a, b in _DELIMS:
        if t.startswith(a) and t.endswith(b) and len(t) > len(a) + len(b):
            return t[len(a):-len(b)].strip()
    return t


def docx_math_map(docx_path):
    """Return ({wmf_basename: latex}, n_failed). Converts every MathType OLE equation in
    the docx via the MathType SDK and keys it by its WMF preview image filename — the
    same name pandoc's --extract-media emits, so markdown image refs can be swapped."""
    dll = mt6_path()
    if not dll:
        return {}, 0

    z = zipfile.ZipFile(docx_path)
    names = set(z.namelist())
    if "word/document.xml" not in names or not any("embeddings/" in n for n in names):
        return {}, 0

    # rels: rId -> target path (embeddings/oleObjectN.bin, media/imageM.wmf)
    rels = {}
    if "word/_rels/document.xml.rels" in names:
        root = ET.fromstring(z.read("word/_rels/document.xml.rels"))
        for rel in root.findall("rel:Relationship", _NS):
            rels[rel.get("Id")] = rel.get("Target", "").lstrip("/")

    # pair each Equation OLE with its preview image via <w:object>
    doc = ET.fromstring(z.read("word/document.xml"))
    rid_attr = "{%s}id" % _NS["r"]
    pairs = []  # (ole_zip_path, wmf_basename)
    for obj in doc.iter("{%s}object" % _NS["w"]):
        ole = obj.find(".//{%s}OLEObject" % _NS["o"])
        if ole is None or not _EQ_PROGID.match(ole.get("ProgID", "")):
            continue
        img = obj.find(".//{%s}imagedata" % _NS["v"])
        if img is None:
            continue
        ole_target = rels.get(ole.get(rid_attr, ""))
        img_target = rels.get(img.get(rid_attr, ""))
        if not (ole_target and img_target):
            continue
        pairs.append(("word/" + ole_target if not ole_target.startswith("word/") else ole_target,
                      os.path.basename(img_target)))
    if not pairs:
        return {}, 0

    math_map = {}
    failed = 0
    mt = _MT6(dll)
    try:
        mt.set_translator("AMS LaTeX.tdl")
        for ole_path, wmf_name in pairs:
            try:
                if ole_path not in names:
                    failed += 1
                    continue
                mtef = _read_mtef(z.read(ole_path))
                if not mtef:
                    failed += 1
                    continue
                latex = _strip_delims(mt.mtef_to_text(mtef))
                if latex:
                    math_map[wmf_name] = latex
                else:
                    failed += 1
            except Exception:
                log.exception("mtef: conversion failed for %s (%s)", ole_path, wmf_name)
                failed += 1
    finally:
        mt.close()
    log.info("mtef: %s -> %d equation(s) converted, %d failed",
             os.path.basename(docx_path), len(math_map), failed)
    return math_map, failed


# ![...](path/imageM.wmf){attrs}  /  ![...](path/imageM.wmf)
_IMG_MD = re.compile(r"!\[[^\]]*\]\(([^)]+?)\)(\{[^}]*\})?")


def replace_wmf_math(markdown, math_map):
    """Swap pandoc image references whose target is a converted equation WMF for real
    inline LaTeX math ($...$). Returns (new_markdown, n_replaced)."""
    if not math_map:
        return markdown, 0
    count = [0]

    def repl(m):
        base = os.path.basename(m.group(1).strip())
        latex = math_map.get(base)
        if latex is None:
            return m.group(0)
        count[0] += 1
        return "$%s$" % latex

    return _IMG_MD.sub(repl, markdown), count[0]
