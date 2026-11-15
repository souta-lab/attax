#!/usr/bin/env python3
"""Build the attax paper PDF from main.md.

Pipeline: preprocess main.md (lift title/author/abstract into pandoc
metadata), pandoc -> main.tex, rewrite the manually tagged display
equations ($$... \\qquad (n)$$) as numbered equation environments,
normalize stray text-mode unicode (superscripts, minus, middot, ...)
to LaTeX, then compile with LuaLaTeX (TeX Live).

Usage: python3 paper/build.py   (from the repository root)
Produces: paper/main.tex, paper/main.pdf, attax-paper.pdf (repo root).
"""
import re
import subprocess
import sys
from pathlib import Path

PAPER = Path(__file__).resolve().parent
ROOT = PAPER.parent
PANDOC = Path.home() / ".local/opt/pandoc-3.14/bin/pandoc"
LUALATEX = Path.home() / "texlive/bin/x86_64-linux/lualatex"

_SUP = {
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-",
}


def normalize_unicode(tex: str) -> str:
    """Rewrite text-mode unicode that Latin Modern cannot typeset.

    All such characters in the generated .tex occur outside math
    (the markdown math is pure ASCII), so global replacement is safe.
    """
    tex = re.sub(
        r"[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+",
        lambda m: "\\textsuperscript{"
        + "".join(_SUP[ch] for ch in m.group(0))
        + "}",
        tex,
    )
    return (
        tex.replace("−", "\\(-\\)")
        .replace("·", "\\(\\cdot\\)")
        .replace("≈", "\\(\\approx\\)")
        .replace("×", "\\(\\times\\)")
        .replace("Δ", "\\(\\Delta\\)")
    )


def main() -> int:
    src = (PAPER / "main.md").read_text(encoding="utf-8")

    # --- extract front matter -------------------------------------------------
    title = re.search(r"^# (.+)$", src, re.M).group(1).strip()
    author = re.search(r"^\*\*(.+)\*\*$", src, re.M).group(1).strip()
    abstract = re.search(
        r"^## Abstract\s*\n(.*?)\n^## ", src, re.M | re.S
    ).group(1).strip()
    # Body: everything from the first numbered section on.
    body = src[src.index("## 1. Introduction"):]
    # Join the abstract's wrapped lines into single paragraphs.
    abstract = "\n\n".join(
        " ".join(p.split()) for p in abstract.split("\n\n")
    )

    meta = (
        f'title: "{title}"\n'
        f'author: "{author}"\n'
        'date: "Draft v2 — November 2026"\n'
        "abstract: |\n"
        + "\n".join("  " + line for line in abstract.splitlines())
        + "\ngeometry: margin=1in\n"
        + "fontsize: 11pt\n"
        + "colorlinks: true\n"
    )
    (PAPER / "_meta.yaml").write_text(meta, encoding="utf-8")
    (PAPER / "_body.md").write_text(body, encoding="utf-8")

    # --- pandoc: markdown -> LaTeX -------------------------------------------
    subprocess.run(
        [
            str(PANDOC),
            str(PAPER / "_body.md"),
            "--metadata-file", str(PAPER / "_meta.yaml"),
            "--shift-heading-level-by=-1",
            "--standalone",
            "-o", str(PAPER / "main.tex"),
        ],
        check=True,
    )
    tex = (PAPER / "main.tex").read_text(encoding="utf-8")

    # --- display math \[ ... \qquad (n) \] -> \begin{equation} ... ------------
    tags: list[int] = []

    def repl(m: re.Match) -> str:
        tags.append(int(m.group(2)))
        return "\\begin{equation}" + m.group(1).rstrip() + "\n\\end{equation}"

    tex, n = re.subn(
        r"\\\[(.*?)\\qquad\s*\((\d+)\)\s*\\\]", repl, tex, flags=re.S
    )
    if n != 18 or tags != list(range(1, 19)):
        print(f"equation rewrite mismatch: n={n}, tags={tags}", file=sys.stderr)
        return 1
    # Any untagged display math left over?
    if "\\[" in tex:
        print("warning: untagged display math remains", file=sys.stderr)
    tex = normalize_unicode(tex)
    (PAPER / "main.tex").write_text(tex, encoding="utf-8")

    # --- compile (3 passes: longtable widths + cross-references) --------------
    for _ in range(3):
        subprocess.run(
            [str(LUALATEX), "-interaction=nonstopmode", "main.tex"],
            cwd=PAPER, check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
        )
    (ROOT / "attax-paper.pdf").write_bytes((PAPER / "main.pdf").read_bytes())

    for tmp in ("_meta.yaml", "_body.md"):
        (PAPER / tmp).unlink()
    print("built attax-paper.pdf")
    return 0


if __name__ == "__main__":
    sys.exit(main())
