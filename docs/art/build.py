"""Build the README artwork for notebooklm-curator.

Outputs (all under docs/):
  hero-dark.svg, hero-light.svg                 1280 x 480, animated
  hero-mobile-dark.svg, hero-mobile-light.svg   640 x 980, animated
  demo-dark.svg, demo-light.svg                 1280 x 960, plays once
  art/social-preview.svg, art/icon.svg          static sources for the PNGs

The PNGs (docs/demo.png, docs/social-preview.png, docs/icon.png) are
rendered from these SVGs by docs/art/render.cjs.

Motion is plain CSS inside the SVG, which GitHub plays when it shows the
file as an image. Every element's resting state is the complete
composition, so with prefers-reduced-motion the artwork is static and whole.

Text is converted to outlines so the artwork renders with the intended
typefaces everywhere (GitHub cannot load web fonts into images). Each glyph
is defined once in <defs> and placed with <use>, which keeps files small.

Visual language follows the For Creative Works profile artwork
(github.com/furkancakmakcreative): same palette, type and motion rules.

Requirements: pip install fonttools uharfbuzz
Fonts (not committed), all TTF:
  Inter 4.1        https://github.com/rsms/inter/releases  (extras/ttf)
                   InterDisplay-SemiBold, Inter-Regular, Inter-Medium
  JetBrains Mono   https://github.com/JetBrains/JetBrainsMono/releases
                   JetBrainsMono-Regular, JetBrainsMono-Medium

Usage:
  FONT_DIR=/path/to/fonts python3 docs/art/build.py
  node docs/art/render.cjs          # PNGs, needs playwright + chromium
"""

import os
from html import escape
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
ART = DOCS / "art"
FONT_DIR = Path(os.environ.get("FONT_DIR", ROOT / ".fonts"))

FONTS = {
    "display": ("InterDisplay-SemiBold.ttf", "d"),
    "text": ("Inter-Regular.ttf", "t"),
    "text-medium": ("Inter-Medium.ttf", "u"),
    "mono": ("JetBrainsMono-Regular.ttf", "m"),
    "mono-medium": ("JetBrainsMono-Medium.ttf", "n"),
}

# For Creative Works palette. Brand green #0B8F63 is for fills and dots;
# small green text on dark uses the lighter accent-text.
THEMES = {
    "dark": {
        "bg": "#050505",
        "panel": "#0C0D0D",
        "ink": "#F5F7F6",
        "muted": "#8B918E",
        "faint": "#3A3E3C",
        "line": "#262928",
        "accent": "#0B8F63",
        "accent-text": "#22B783",
        "on-accent": "#F5F7F6",
        "amber": "#E7882C",
        "amber-text": "#E7882C",
    },
    "light": {
        "bg": "#F5F7F6",
        "panel": "#FFFFFF",
        "ink": "#050505",
        "muted": "#5E6461",
        "faint": "#C9CFCC",
        "line": "#DCE1DE",
        "accent": "#0B8F63",
        "accent-text": "#0B8F63",
        "on-accent": "#FFFFFF",
        "amber": "#E7882C",
        "amber-text": "#B4600E",
    },
}

EASE = "cubic-bezier(.16,1,.3,1)"

BASE_CSS = """
.fb{transform-box:fill-box}
.c{transform-origin:center}
.l{transform-origin:left center}
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes fadeLeft{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes rise{from{transform:translateY(140px)}to{transform:none}}
@keyframes drawX{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes pop{0%{transform:scale(0)}60%{transform:scale(1.3)}100%{transform:scale(1)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
"""


def num(v, places=2):
    s = f"{v:.{places}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def anim(name, dur, delay=0.0, count="1", ease=EASE):
    return f"animation:{name} {dur}s {ease} {delay:.2f}s {count} both"


def loop(name, dur, delay=0.0, ease=EASE):
    return f"animation:{name} {dur}s {ease} {delay:.2f}s infinite both"


def frames(period, points):
    """Keyframes from (seconds, css) points. Points outside [0, period] are clamped."""
    out, seen = [], {}
    for t, css in sorted(points, key=lambda p: p[0]):
        pct = num(max(0.0, min(period, t)) / period * 100, 3)
        seen[pct] = css
    for pct, css in seen.items():
        out.append(f"{pct}%{{{css}}}")
    return "".join(out)


def windows(period, spans, ramp=0.25, on="opacity:1", off="opacity:0"):
    """Opacity (or any two-state) keyframes: visible during each (start, end) span."""
    covered = lambda t: any(a <= t <= b for a, b in spans)
    pts = [(0, on if covered(0) else off), (period, on if covered(period) else off)]
    for a, b in spans:
        if a > 0:
            pts += [(a, off), (a + ramp, on)]
        if b < period:
            pts += [(b, on), (b + ramp, off)]
    return frames(period, pts)


class Font:
    def __init__(self, filename):
        path = FONT_DIR / filename
        self.tt = TTFont(path)
        self.glyphs = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()
        self.upem = self.tt["head"].unitsPerEm
        self.hb = hb.Font(hb.Face(hb.Blob.from_file_path(str(path))))
        self._outline = {}

    def shape(self, text, size, tracking=0.0, features=None):
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        feats = {"kern": True, "liga": True}
        feats.update(features or {})
        hb.shape(self.hb, buf, feats)
        scale = size / self.upem
        placed, pen_x = [], 0.0
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            placed.append((self.order[info.codepoint], pen_x + pos.x_offset * scale, pos.y_offset * scale))
            pen_x += pos.x_advance * scale + tracking * size
        return placed, pen_x - tracking * size

    def width(self, text, size, tracking=0.0, features=None):
        return self.shape(text, size, tracking, features)[1]

    def outline(self, name):
        """Glyph path at a 100px em, y-down, origin on the baseline."""
        if name not in self._outline:
            pen = SVGPathPen(self.glyphs, ntos=lambda v: num(v, 1))
            s = 100 / self.upem
            self.glyphs[name].draw(TransformPen(pen, (s, 0, 0, -s, 0, 0)))
            self._outline[name] = pen.getCommands()
        return self._outline[name]


class Canvas:
    """Collects SVG elements, glyph defs and keyframes for one file."""

    def __init__(self, w, h, fonts, colors, still=False):
        self.w, self.h, self.f, self.c = w, h, fonts, colors
        self.still = still
        self.body, self.css, self.defs = [], [], []
        self.glyph_ids = {}

    def add(self, s):
        self.body.append(s)

    def keyframes(self, name, body):
        self.css.append(f"@keyframes {name}{{{body}}}")

    def gid(self, fk, name):
        key = (fk, name)
        if key not in self.glyph_ids:
            self.glyph_ids[key] = f"{FONTS[fk][1]}{len(self.glyph_ids):x}"
        return self.glyph_ids[key]

    def width(self, fk, s, size, tracking=0.0, features=None):
        return self.f[fk].width(s, size, tracking, features)

    def uses(self, fk, s, size, tracking=0.0, features=None, style_for=None):
        """<use> list for a run placed at the origin, in 100px-em units."""
        font = self.f[fk]
        placed, width = font.shape(s, size, tracking, features)
        k = size / 100
        out, i = [], 0
        for name, gx, gy in placed:
            if not font.outline(name):
                continue
            st = f' style="{style_for(i)}"' if style_for else ""
            y = f' y="{num(-gy / k, 1)}"' if gy else ""
            out.append(f'<use xlink:href="#{self.gid(fk, name)}" x="{num(gx / k, 1)}"{y}{st}/>')
            i += 1
        return out, width

    def text(self, fk, s, size, x, y, color="ink", tracking=0.0, anchor="start",
             style="", cls="", features=None, attrs=""):
        uses, width = self.uses(fk, s, size, tracking, features)
        x -= {"start": 0, "middle": width / 2, "end": width}[anchor]
        fill = f' fill="{self.c[color]}"' if color else ""
        wrap = bool(style or cls)
        g = (f'<g transform="translate({num(x)} {num(y)}) scale({num(size / 100, 4)})"{fill}{"" if wrap else attrs}>'
             + "".join(uses) + "</g>")
        if wrap:
            c = f' class="{cls}"' if cls else ""
            s_ = f' style="{style}"' if style else ""
            g = f"<g{c}{s_}{attrs}>{g}</g>"
        return g

    def crop_marks(self, inset, length, gap, style=""):
        d = []
        for cx, sx in ((inset, 1), (self.w - inset, -1)):
            for cy, sy in ((inset, 1), (self.h - inset, -1)):
                d.append(f"M{cx - sx * (gap + length)} {cy}h{sx * length}")
                d.append(f"M{cx} {cy - sy * (gap + length)}v{sy * length}")
        st = f' style="{style}"' if style else ""
        return f'<path{st} d="{"".join(d)}" stroke="{self.c["faint"]}" stroke-width="1.5" fill="none"/>'

    def render(self, title, desc):
        glyphs = "".join(
            f'<path id="{gid}" d="{self.f[fk].outline(name)}"/>' for (fk, name), gid in self.glyph_ids.items()
        )
        style = "" if self.still else f"<style>{BASE_CSS}{''.join(self.css)}</style>\n"
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}" role="img" '
            f'aria-labelledby="title desc">\n'
            f'<title id="title">{escape(title)}</title>\n<desc id="desc">{escape(desc)}</desc>\n'
            + style
            + f"<defs>{glyphs}{''.join(self.defs)}</defs>\n"
            + "\n".join(self.body)
            + "\n</svg>\n"
        )


# ---------------------------------------------------------------- hero
#
# The library panel is one seamless 12 s loop in three beats:
#   WATCH  a new video from a followed channel lands at the bottom, tagged NEW
#   AUDIT  a scan passes; every row's age and shelf-life tag is rewritten
#   PRUNE  the stale row gets an approval check, is struck, collapses out,
#          and the rows below close the gap
# The rows are a conveyor. Each cycle a row ages one step (about a month) and
# moves up one slot, so the list after a cycle looks exactly like the list
# before it. Five row elements share one 60 s life (5 cycles) offset by 12 s,
# which makes the loop seamless without any reset frame.

T = 12.0
LIFE = 5 * T
GAP = 44
Y1 = 72                  # centre of slot 1, panel-local
HEAD = 50                # divider under the panel caption
PH = 384                 # panel height
AGES = ["4d", "34d", "64d", "94d", "124d"]   # 30 days per cycle, 120 d shelf life
STATUS = [
    ("NEW VIDEO FROM A FOLLOWED CHANNEL", "ink", [(0.4, 2.8)]),
    ("CHECKING SHELF LIFE", "ink", [(2.8, 6.4)]),
    ("APPROVE REMOVAL?", "ink", [(6.4, 7.5)]),
    ("REMOVED WITH YOUR APPROVAL", "ink", [(7.5, 9.8)]),
    ("LIBRARY FRESH", "accent-text", [(0, 0.4), (9.8, T)]),
]
BEATS = [
    ("WATCH", "Adds new videos from the channels you follow.", [(0, 2.8), (9.8, T)]),
    ("AUDIT", "Flags sources past their shelf life.", [(0, 0.4), (2.8, 6.4), (9.8, T)]),
    ("PRUNE", "Removes nothing without your approval.", [(0, 0.4), (6.4, T)]),
]
ENTER = (0.6, 1.5)
SCAN = (3.0, 6.0)
CHECK_SHOW, CHECK_TICK, STRIKE, EXIT, CLOSE = 6.6, 7.5, (7.7, 8.1), (8.2, 8.7), (8.8, 9.5)


def slot_y(k):
    return Y1 + (k - 1) * GAP


def scan_t(k):
    """When the scan line crosses slot k."""
    y0, y1 = HEAD, HEAD + 7 * GAP
    return SCAN[0] + (SCAN[1] - SCAN[0]) * (slot_y(k) - y0) / (y1 - y0)


def row_art(cv, PW, bar, chan, y):
    c = cv.c
    return (
        f'<rect x="24" y="{y - 7}" width="20" height="14" rx="2" fill="none" stroke="{c["muted"]}" stroke-width="1.5"/>'
        f'<path d="M31.5 {y - 3.5}l6 3.5-6 3.5z" fill="{c["muted"]}"/>'
        f'<rect x="58" y="{y - 8}" width="{bar:.0f}" height="7" rx="3.5" fill="{c["faint"]}"/>'
        f'<rect x="58" y="{y + 4}" width="{chan:.0f}" height="5" rx="2.5" fill="{c["faint"]}" fill-opacity=".55"/>'
    )


def tag(cv, PW, label, y, color):
    return cv.text("mono-medium", label, 11, PW - 22, y + 4, color, 0.12, "end")


def new_pill(cv, PW, y):
    w = cv.width("mono-medium", "NEW", 11, 0.12) + 14
    return (f'<rect x="{PW - 22 - w:.1f}" y="{y - 9}" width="{w:.1f}" height="18" fill="{cv.c["accent"]}"/>'
            + cv.text("mono-medium", "NEW", 11, PW - 29, y + 4, "on-accent", 0.12, "end"))


def library_panel(cv, PW, p, D):
    """Library panel in local coords (PW x PH). D is the global loop offset."""
    c, out = cv.c, []
    maxbar = PW - 58 - 170
    out.append(f'<rect width="{PW}" height="{PH}" fill="{c["panel"]}" stroke="{c["line"]}" stroke-width="1.5"/>')
    out.append(cv.text("mono", "SOURCES", 12, 22, 32, "muted", 0.1))
    out.append(f'<path d="M0 {HEAD}H{PW}" stroke="{c["line"]}" stroke-width="1.5"/>')

    # Header status, one line per phase. Resting state: waiting for approval.
    for i, (label, col, spans) in enumerate(STATUS):
        k = f"{p}st{i}"
        # Fade out before the next line fades in, so two lines never overlap.
        cv.keyframes(k, windows(T, [(a, b if b >= T else b - 0.25) for a, b in spans], 0.25))
        rest = "1" if label == "APPROVE REMOVAL?" else "0"
        out.append(cv.text("mono-medium", label, 12, PW - 22, 32, col, 0.1, "end",
                           attrs=f' opacity="{rest}"', style=loop(k, T, D, "linear")))

    # A soft band marks the arriving row while it settles in.
    cv.keyframes(f"{p}arr", windows(T, [(ENTER[0], 2.6)], 0.5))
    out.append(f'<rect opacity="0" style="{loop(p + "arr", T, D, "linear")}" x="1" y="{slot_y(7) - GAP / 2}" '
               f'width="{PW - 2}" height="{GAP}" fill="{c["accent"]}" fill-opacity=".08"/>')

    # Pinned rows never age and never move.
    for k, (bar, chan) in enumerate([(0.74, 0.3), (0.56, 0.22)], start=1):
        y = slot_y(k)
        out.append(row_art(cv, PW, bar * maxbar, chan * maxbar, y) + tag(cv, PW, "PINNED", y, "muted"))

    # Scan line, drawn beneath the rows' tags.
    sy0, sy1 = HEAD, HEAD + 7 * GAP
    cv.keyframes(f"{p}scan", frames(T, [
        (0, f"transform:translateY(0);opacity:0"), (SCAN[0] - 0.05, "transform:translateY(0);opacity:0"),
        (SCAN[0] + 0.15, "opacity:1"), (SCAN[1] - 0.15, "opacity:1"),
        (SCAN[1], f"transform:translateY({sy1 - sy0}px);opacity:0"), (T, f"transform:translateY({sy1 - sy0}px);opacity:0")]))
    out.append(f'<g opacity="0" style="{loop(p + "scan", T, D, "linear")}">'
               f'<rect x="1" y="{sy0 - 30}" width="{PW - 2}" height="30" fill="{c["accent"]}" opacity=".09"/>'
               f'<path d="M1 {sy0}H{PW - 1}" stroke="{c["accent"]}" stroke-width="1.5"/></g>')

    # The five conveyor rows. Element e is e cycles into its life at loop start.
    bars = [(0.9, 0.26), (0.64, 0.34), (1.0, 0.22), (0.72, 0.3), (0.84, 0.2)]
    tr = lambda x, slot: f"transform:translate({x}px,{(slot - 1) * GAP}px)"
    life = [(0, "opacity:0;" + tr(24, 7)), (ENTER[0], "opacity:0;" + tr(24, 7)), (ENTER[1], "opacity:1;" + tr(0, 7))]
    for cyc in range(4):
        life += [(cyc * T + CLOSE[0], "opacity:1;" + tr(0, 7 - cyc)), (cyc * T + CLOSE[1], "opacity:1;" + tr(0, 6 - cyc))]
    end = 4 * T + EXIT[1]
    life += [(4 * T + EXIT[0], "opacity:1;" + tr(0, 3)), (end, "opacity:0;" + tr(-32, 3)),
             (end + 0.05, "opacity:0;" + tr(24, 7)), (LIFE, "opacity:0;" + tr(24, 7))]
    cv.keyframes(f"{p}life", frames(LIFE, life))

    # Tag and age windows over one life. Crossings follow the scan.
    cross = lambda cyc, slot: cyc * T + scan_t(slot)
    variants = {
        "NEW": [(0, cross(0, 7))],
        "FRESH": [(cross(0, 7), cross(3, 4))],
        "AGING": [(cross(3, 4), cross(4, 3))],
        "STALE": [(cross(4, 3), end)],
    }
    for i, a in enumerate(AGES):
        variants[a] = [(cross(i, 7 - i), cross(i + 1, 6 - i) if i < 4 else end)]
    for name, spans in variants.items():
        cv.keyframes(f"{p}v{name}", windows(LIFE, spans, 0.3))

    # Resting composition: after the audit, before approval, NEW row in place.
    rest_tags = ["NEW", "FRESH", "FRESH", "AGING", "STALE"]
    for e in range(5):
        slot = 7 - e
        delay = D - e * T
        y = Y1
        bar, chan = bars[e]
        parts = [row_art(cv, PW, bar * maxbar, chan * maxbar, y)]
        for name, color in (("NEW", None), ("FRESH", "accent-text"), ("AGING", "amber-text"), ("STALE", "ink")):
            art = new_pill(cv, PW, y) if name == "NEW" else tag(cv, PW, name, y, color)
            rest = "1" if rest_tags[e] == name else "0"
            parts.append(f'<g opacity="{rest}" style="{loop(p + "v" + name, LIFE, delay, "linear")}">{art}</g>')
        for i, a in enumerate(AGES):
            rest = "1" if i == e else "0"
            parts.append(f'<g opacity="{rest}" style="{loop(p + "v" + a, LIFE, delay, "linear")}">'
                         + cv.text("mono", a, 12, PW - 104, y + 4, "muted", 0.04, "end") + "</g>")
        out.append(f'<g transform="translate(0 {(slot - 1) * GAP})" style="{loop(p + "life", LIFE, delay)}">'
                   + "".join(parts) + "</g>")

    # Approval on slot 3: checkbox over the thumbnail, tick, strike, exit.
    y3 = slot_y(3)
    cv.keyframes(f"{p}ap", frames(T, [
        (0, "opacity:0;transform:none"), (CHECK_SHOW, "opacity:0;transform:none"), (CHECK_SHOW + 0.3, "opacity:1;transform:none"),
        (EXIT[0], "opacity:1;transform:none"), (EXIT[1], "opacity:0;transform:translateX(-32px)"), (T, "opacity:0;transform:translateX(-32px)")]))
    cv.keyframes(f"{p}tick", frames(T, [(0, "opacity:0"), (CHECK_TICK, "opacity:0"), (CHECK_TICK + 0.15, "opacity:1"), (T, "opacity:1")]))
    cv.keyframes(f"{p}strike", frames(T, [(0, "transform:scaleX(0)"), (STRIKE[0], "transform:scaleX(0)"),
                                          (STRIKE[1], "transform:scaleX(1)"), (T, "transform:scaleX(1)")]))
    out.append(
        f'<g style="{loop(p + "ap", T, D)}">'
        f'<rect x="21" y="{y3 - 10}" width="26" height="20" fill="{c["panel"]}"/>'
        f'<rect x="26" y="{y3 - 8}" width="16" height="16" fill="{c["panel"]}" stroke="{c["ink"]}" stroke-width="1.5"/>'
        f'<g opacity="0" style="{loop(p + "tick", T, D, "linear")}">'
        f'<rect x="25.25" y="{y3 - 8.75}" width="17.5" height="17.5" fill="{c["accent"]}"/>'
        f'<path d="M29.5 {y3}l3 3 6-6.5" fill="none" stroke="{c["on-accent"]}" stroke-width="2" stroke-linecap="square"/></g>'
        f'<path class="fb l" transform="scale(0 1)" style="{loop(p + "strike", T, D)}" d="M54 {y3 - 1}H{PW - 18}" '
        f'stroke="{c["ink"]}" stroke-width="1.5"/></g>'
    )
    return out


def beat_list(cv, x, y, gap, size, p, D, label_w):
    """Three beat lines; the active one lights up in sync with the panel."""
    c = cv.c
    for i, (label, line, spans) in enumerate(BEATS):
        k = f"{p}b{i}"
        cv.keyframes(k, windows(T, spans, 0.3, f"fill:{c['accent-text']}", f"fill:{c['muted']}"))
        cv.add(f'<g fill="{c["accent-text"]}" style="{loop(k, T, D, "linear")}">'
               + cv.text("mono-medium", label, size * 0.72, x + 16, y + i * gap - 1, None, 0.14) + "</g>")
        cv.add(cv.text("text", line, size, x + 16 + label_w, y + i * gap, "muted"))
    # Marker square travels to the active beat; rests on PRUNE.
    pts, py = [], lambda i: f"transform:translateY({(i - 2) * gap}px)"
    pts = [(0, py(2)), (0.4, py(2)), (0.9, py(0)), (2.8, py(0)), (3.3, py(1)), (6.4, py(1)), (6.9, py(2)), (T, py(2))]
    cv.keyframes(f"{p}mk", frames(T, pts))
    cv.add(f'<rect style="{loop(p + "mk", T, D)}" x="{x}" y="{y + 2 * gap - 9}" width="7" height="7" fill="{c["accent"]}"/>')


def title_rise(cv, size, x, y, delay, p):
    cv.add(f'<clipPath id="{p}nm"><rect x="0" y="{y - size}" width="{cv.w}" height="{size * 1.35:.0f}"/></clipPath>')
    uses, _ = cv.uses("display", "notebooklm-curator", size, -0.02,
                      style_for=lambda i: anim("rise", 1.1, delay + i * 0.035))
    cv.add(f'<g clip-path="url(#{p}nm)"><g transform="translate({x} {y}) scale({num(size / 100, 4)})" '
           f'fill="{cv.c["ink"]}">{"".join(uses)}</g></g>')


HERO_TITLE = "notebooklm-curator"
HERO_DESC = ("Keeps your NotebookLM library fresh. Adds new videos from the channels you follow, "
             "flags sources past their shelf life, and removes nothing without your approval. "
             "Animation: a new video joins the library, a scan tags every source fresh, aging or stale, "
             "and the stale one is removed after an approval check.")


def label_row(cv, x, y, size, delay):
    cv.add(f'<rect style="{anim("pop", 0.6, delay)}" class="fb c" x="{x}" y="{y - size * 0.62:.1f}" width="7" height="7" fill="{cv.c["accent"]}"/>')
    cv.add(cv.text("mono-medium", "OPEN SOURCE · MCP", size, x + 18, y, "ink", 0.14, style=anim("fadeUp", 0.9, delay + 0.05)))


def hero_desktop(f, c):
    w, h, m, D = 1280, 480, 72, 1.2
    cv = Canvas(w, h, f, c)
    cv.add(f'<rect width="{w}" height="{h}" fill="{c["bg"]}"/>')
    cv.add(cv.crop_marks(24, 14, 5, anim("fade", 1.2, 0.1)))
    label_row(cv, m, 96, 13, 0.15)
    title_rise(cv, min(70, 70 * 500 / cv.width("display", HERO_TITLE, 70, -0.02)), m - 3, 186, 0.3, "h")
    cv.add(cv.text("text", "Keeps your NotebookLM library fresh.", 27, m - 1, 236, "ink", style=anim("fadeUp", 1.0, 0.9)))
    cv.add(f'<g style="{anim("fadeUp", 1.0, 1.05)}">')
    beat_list(cv, m, 300, 32, 16.5, "h", D, 72)
    cv.add("</g>")
    cv.add(f'<path class="fb l" style="{anim("drawX", 1.3, 0.9)}" d="M{m} 396H{m + 470}" stroke="{c["line"]}" stroke-width="1.5"/>')
    cv.add(cv.text("mono", "WORKS IN CLAUDE DESKTOP AND CLAUDE CODE", 12, m, 432, "muted", 0.14, style=anim("fadeUp", 0.9, 1.3)))
    PW = 568
    cv.add(f'<g transform="translate({w - m - PW + 8} 48)"><g style="{anim("fadeLeft", 1.0, 0.45)}">'
           + "".join(library_panel(cv, PW, "h", D)) + "</g></g>")
    return cv.render(HERO_TITLE, HERO_DESC)


def hero_mobile(f, c):
    w, h, m, D = 640, 1000, 40, 1.2
    cv = Canvas(w, h, f, c)
    cv.add(f'<rect width="{w}" height="{h}" fill="{c["bg"]}"/>')
    cv.add(cv.crop_marks(18, 12, 5, anim("fade", 1.2, 0.1)))
    label_row(cv, m, 82, 16, 0.15)
    size = min(84, 84 * (w - 2 * m) / cv.width("display", HERO_TITLE, 84, -0.02))
    title_rise(cv, size, m - 3, 176, 0.3, "m")
    cv.add(cv.text("text", "Keeps your NotebookLM", 34, m - 1, 238, "ink", style=anim("fadeUp", 1.0, 0.9)))
    cv.add(cv.text("text", "library fresh.", 34, m - 1, 280, "ink", style=anim("fadeUp", 1.0, 0.95)))
    cv.add(f'<g style="{anim("fadeUp", 1.0, 1.05)}">')
    beat_list(cv, m, 346, 38, 20.5, "m", D, 88)
    cv.add("</g>")
    PW, scale = 448, (w - 2 * m) / 448
    cv.add(f'<g transform="translate({m} 452) scale({num(scale, 4)})"><g style="{anim("fadeUp", 1.0, 0.45)}">'
           + "".join(library_panel(cv, PW, "m", D)) + "</g></g>")
    cv.add(f'<rect x="{m}" y="{h - 52}" width="7" height="7" fill="{c["accent"]}"/>')
    cv.add(cv.text("mono", "WORKS IN CLAUDE DESKTOP AND CLAUDE CODE", 15, m + 18, h - 44, "muted", 0.1, style=anim("fadeUp", 0.9, 1.3)))
    return cv.render(HERO_TITLE, HERO_DESC)


# ---------------------------------------------------------------- demo
# Counts and stale rows are from a real nlm_audit run; the titles are
# representative examples. It plays once and rests on the complete card.

STATS = [("TOTAL", 56, "ink"), ("FRESH", 3, "accent-text"), ("AGING", 3, "amber-text"),
         ("STALE", 5, "stale"), ("UNKNOWN", 45, "muted"), ("PINNED", 0, "muted")]
STALE_ROWS = [
    ("Model X Just Shipped a Major Update", "news", 134, 104),
    ("Stop Using This Old Prompting Trick", "tactics", 118, 73),
    ("20 Terminal Shortcuts in 20 Minutes", "tool", 126, 66),
    ("30 Tricks to Speed Up Your Workflow", "tool", 100, 40),
    ("Building Agents with the New SDK", "tool", 77, 17),
]
USER_MSG = "Audit my “AI & Automation” notebook. Anything gone stale?"
REPLY = [
    [("Found ", "ink"), ("5 stale sources", "accent-text"), (" and ", "ink"), ("1 duplicate", "accent-text"),
     (", mostly time-sensitive news and tactics videos past", "ink")],
    [("their shelf life. Want me to remove any of these?", "ink")],
]
DEMO_DESC = ("Example session: asked to audit the AI & Automation notebook, the assistant calls nlm_audit. "
             "Result: 56 sources, 3 fresh, 3 aging, 5 stale, 45 unknown, 0 pinned. Stale: "
             + "; ".join(f"{t} ({cat}, {age}d old, over by {o}d)" for t, cat, age, o in STALE_ROWS)
             + ". Duplicates: 1 title × 2 copies. YouTube searches used: 20. "
             "Reply: Found 5 stale sources and 1 duplicate, mostly time-sensitive news and tactics videos "
             "past their shelf life. Want me to remove any of these?")


def odometer(cv, x, y, size, value, color, delay, p, fill):
    """Number that rolls up to its value. Rests on the final value."""
    feats = {"tnum": True}
    adv = cv.width("display", "0", size, 0, feats)
    lh = size * 1.25
    digits = str(value)
    out = []
    for i, d in enumerate(digits):
        tens = len(digits) == 2 and i == 0
        seq = [""] + [str(n) for n in range(1, 10)] if tens else [str(n % 10) for n in range(20)]
        target = int(d) if tens else 10 + int(d)
        dx = x + i * adv
        strip = "".join(cv.text("display", s, size, dx, y + j * lh, None, 0, features=feats) for j, s in enumerate(seq) if s)
        k = f"{p}{i}"
        cv.keyframes(k, f"from{{transform:translateY(0)}}to{{transform:translateY({-target * lh:.1f}px)}}")
        dur = 1.1 + 0.25 * (not tens)
        out.append(f'<g fill="{fill}" transform="translate(0 {-target * lh:.1f})" '
                   f'style="animation:{k} {dur}s cubic-bezier(.2,.8,.2,1) {delay:.2f}s 1 both">{strip}</g>')
    cid = f"{p}clip"
    cv.defs.append(f'<clipPath id="{cid}"><rect x="{x - 4}" y="{y - size * 0.9:.1f}" width="{adv * 2 + 8:.1f}" height="{size * 1.1:.1f}"/></clipPath>')
    return f'<g clip-path="url(#{cid})">{"".join(out)}</g>'


def demo(f, c):
    w, h, m = 1280, 960, 64
    cv = Canvas(w, h, f, c)
    stale_ink = c["ink"]
    cv.add(f'<rect width="{w}" height="{h}" fill="{c["bg"]}"/>')
    cv.add(cv.crop_marks(24, 14, 5))
    cv.add(f'<rect x="{m}" y="58" width="7" height="7" fill="{c["accent"]}"/>')
    cv.add(cv.text("mono-medium", "EXAMPLE SESSION", 13, m + 18, 66, "ink", 0.14))
    cv.add(cv.text("mono", "REAL COUNTS · EXAMPLE TITLES", 13, w - m, 66, "muted", 0.14, "end"))
    cv.add(f'<path d="M{m} 92H{w - m}" stroke="{c["line"]}" stroke-width="1.5"/>')

    # User message, right-aligned.
    size = 21
    tw = cv.width("text", USER_MSG, size)
    bx = w - m - tw - 48
    cv.add(f'<g style="{anim("fadeUp", 0.8, 0.3)}">'
           + cv.text("mono", "YOU", 12, w - m, 136, "muted", 0.14, "end")
           + f'<rect x="{bx:.1f}" y="152" width="{tw + 48:.1f}" height="58" fill="{c["panel"]}" stroke="{c["line"]}" stroke-width="1.5"/>'
           + cv.text("text", USER_MSG, size, bx + 24, 188, "ink") + "</g>")

    # Assistant label and tool chip.
    cv.add(f'<g style="{anim("fadeUp", 0.8, 1.0)}">'
           + f'<rect x="{m}" y="254" width="7" height="7" fill="{c["accent"]}"/>'
           + cv.text("mono", "ASSISTANT", 12, m + 18, 262, "muted", 0.14) + "</g>")
    name_w = cv.width("mono-medium", "nlm_audit", 15, 0.02)
    args = 'notebookId: "a07c…8089"'
    args_w = cv.width("mono", args, 15, 0.02)
    chip_w = 44 + name_w + 14 + args_w + 150
    cy = 302
    cv.keyframes("ring", "0%{transform:scale(1);opacity:.7}100%{transform:scale(3.2);opacity:0}")
    cv.keyframes("busy", "0%,92%{opacity:1}100%{opacity:0}")
    cv.add(
        f'<g style="{anim("fadeUp", 0.8, 1.3)}">'
        f'<rect x="{m}" y="{cy - 22}" width="{chip_w:.1f}" height="44" fill="{c["panel"]}" stroke="{c["line"]}" stroke-width="1.5"/>'
        f'<circle class="fb c" opacity="0" style="animation:ring 0.9s ease-out 1.6s 2 both" cx="{m + 22}" cy="{cy}" r="5" fill="none" stroke="{c["accent"]}" stroke-width="1.5"/>'
        f'<circle cx="{m + 22}" cy="{cy}" r="5" fill="{c["accent"]}"/>'
        + cv.text("mono-medium", "nlm_audit", 15, m + 40, cy + 5, "ink", 0.02)
        + cv.text("mono", args, 15, m + 40 + name_w + 14, cy + 5, "muted", 0.02)
        + cv.text("mono", "running…", 13, m + chip_w - 20, cy + 4, "muted", 0.08, "end", attrs=' opacity="0"',
                  style="animation:busy 1.9s linear 1.3s 1 both")
        + cv.text("mono", "done", 13, m + chip_w - 20, cy + 4, "accent-text", 0.08, "end", style=anim("fade", 0.4, 3.2))
        + "</g>")

    # Result card.
    top, cw = 346, w - 2 * m
    card_delay = 3.3
    cv.add(f'<g style="{anim("fadeUp", 0.8, card_delay)}">'
           f'<rect x="{m}" y="{top}" width="{cw}" height="486" fill="{c["panel"]}" stroke="{c["line"]}" stroke-width="1.5"/></g>')
    # Stat tiles.
    pad, g = 24, 12
    tw_ = (cw - 2 * pad - 5 * g) / 6
    for i, (label, value, col) in enumerate(STATS):
        tx = m + pad + i * (tw_ + g)
        ty = top + pad
        d = card_delay + 0.25 + i * 0.07
        stale = col == "stale"
        fill = c["ink"] if stale else c["bg"]
        num_fill = c["bg"] if stale else c[col]
        lab_col = "bg" if stale else "muted"
        tile = [f'<rect x="{tx:.1f}" y="{ty}" width="{tw_:.1f}" height="104" fill="{fill}"'
                + ("" if stale else f' stroke="{c["line"]}" stroke-width="1.5"') + "/>"]
        tile.append(odometer(cv, tx + 20, ty + 58, 42, value, col, d + 0.15, f"od{i}", num_fill))
        tile.append(cv.text("mono-medium", label, 12, tx + 20, ty + 86, lab_col, 0.14))
        cv.add(f'<g style="{anim("fadeUp", 0.7, d)}">' + "".join(tile) + "</g>")

    # Stale list.
    sy = top + 172
    ld = card_delay + 0.9
    cv.add(f'<g style="{anim("fadeUp", 0.7, ld)}">'
           + cv.text("mono-medium", "STALE", 13, m + pad, sy, "ink", 0.14)
           + cv.text("mono", "PAST SHELF LIFE", 13, m + pad + 66, sy, "muted", 0.14)
           + f'<rect x="{w - m - pad - 250}" y="{sy - 9}" width="16" height="7" fill="{c["faint"]}"/>'
           + cv.text("mono", "SHELF LIFE", 12, w - m - pad - 226, sy, "muted", 0.1)
           + f'<rect x="{w - m - pad - 112}" y="{sy - 9}" width="16" height="7" fill="{stale_ink}"/>'
           + cv.text("mono", "PAST IT", 12, w - m - pad - 88, sy, "muted", 0.1)
           + "</g>")
    px_per_day = 250 / 134
    bar_x = 648
    for i, (title, cat, age, over) in enumerate(STALE_ROWS):
        ry = sy + 44 + i * 48
        d = ld + 0.2 + i * 0.12
        shelf = age - over
        row = [f'<path d="M{m + pad} {ry - 26}H{w - m - pad}" stroke="{c["line"]}" stroke-width="1.5"/>']
        row.append(cv.text("text", title, 18, m + pad, ry + 6, "ink"))
        row.append(cv.text("mono", cat, 14, 552, ry + 5, "muted", 0.02))
        sw, ow = shelf * px_per_day, over * px_per_day
        row.append(f'<rect class="fb l" style="{anim("drawX", 0.7, d + 0.15)}" x="{bar_x}" y="{ry - 3}" width="{sw:.1f}" height="6" fill="{c["faint"]}"/>')
        row.append(f'<rect class="fb l" style="{anim("drawX", 0.7, d + 0.45)}" x="{bar_x + sw + 2:.1f}" y="{ry - 3}" width="{ow - 2:.1f}" height="6" fill="{stale_ink}"/>')
        row.append(cv.text("mono", f"{age}d old", 14, 1032, ry + 5, "muted", 0.02, "end"))
        ob = f"{over}d"
        obw = cv.width("mono-medium", ob, 14, 0.02)
        row.append(cv.text("mono", "over by", 14, w - m - pad - obw - 8, ry + 5, "muted", 0.02, "end"))
        row.append(cv.text("mono-medium", ob, 14, w - m - pad, ry + 5, "ink", 0.02, "end"))
        cv.add(f'<g style="{anim("fadeUp", 0.6, d)}">' + "".join(row) + "</g>")

    fy = sy + 44 + 5 * 48 - 26
    fd = ld + 1.0
    cv.add(f'<g style="{anim("fade", 0.8, fd)}">'
           f'<path d="M{m + pad} {fy}H{w - m - pad}" stroke="{c["line"]}" stroke-width="1.5"/>'
           + cv.text("mono", "duplicates: 1 title × 2 copies", 14, m + pad, fy + 38, "muted", 0.02)
           + cv.text("mono", "YouTube searches used: 20", 14, w - m - pad, fy + 38, "muted", 0.02, "end")
           + "</g>")

    # Final reply.
    ry = top + 486 + 56
    for li, parts in enumerate(REPLY):
        x = m
        runs = []
        for s, col in parts:
            fk = "text-medium" if col != "ink" else "text"
            runs.append(cv.text(fk, s, 21, x, ry + li * 34, col))
            x += cv.width(fk, s, 21)
        cv.add(f'<g style="{anim("fadeUp", 0.8, fd + 0.5 + li * 0.1)}">' + "".join(runs) + "</g>")
    return cv.render("nlm_audit example session", DEMO_DESC)


# ---------------------------------------------------------------- social + icon

def social(f, c):
    w, h, m = 1280, 640, 72
    cv = Canvas(w, h, f, c, still=True)
    cv.add(f'<rect width="{w}" height="{h}" fill="{c["bg"]}"/>')
    cv.add(cv.crop_marks(24, 14, 5))
    cv.add(f'<rect x="{m}" y="{104 - 11}" width="9" height="9" fill="{c["accent"]}"/>')
    cv.add(cv.text("mono-medium", "OPEN SOURCE · MCP", 17, m + 22, 104, "ink", 0.14))
    size = min(80, 80 * 520 / cv.width("display", HERO_TITLE, 80, -0.02))
    cv.add(cv.text("display", HERO_TITLE, size, m - 4, 216, "ink", -0.02))
    cv.add(cv.text("text", "Keeps your NotebookLM", 38, m - 1, 290, "ink"))
    cv.add(cv.text("text", "library fresh.", 38, m - 1, 338, "ink"))
    for i, (label, line, _) in enumerate(BEATS):
        y = 420 + i * 34
        cv.add(cv.text("mono-medium", label, 14, m, y, "accent-text", 0.14))
        cv.add(cv.text("text", line, 18, m + 80, y + 1, "muted"))
    cv.add(cv.text("mono", "github.com/furkancakmakcreative/notebooklm-curator", 17, m, h - 60, "muted", 0.04))
    PW = 520
    cv.add(f'<g transform="translate({w - m - PW * 1.08:.1f} {(h - PH * 1.08) / 2:.1f}) scale(1.08)">' + "".join(library_panel(cv, PW, "s", 0)) + "</g>")
    return cv.render(HERO_TITLE, "Keeps your NotebookLM library fresh.")


def icon(f, c):
    s = 512
    cv = Canvas(s, s, f, c, still=True)
    r = 112
    cv.add(f'<rect x="3" y="3" width="{s - 6}" height="{s - 6}" rx="{r - 3}" fill="{c["bg"]}" stroke="{c["line"]}" stroke-width="6"/>')
    x0, x1 = 100, 412
    rows = [(164, x1, "ink", "accent"), (256, x1 - 72, "ink", "muted"), (348, x1 - 20, "faint", "faint")]
    for y, xe, bar, dot in rows:
        cv.add(f'<circle cx="{x0 + 27}" cy="{y}" r="27" fill="{c[dot]}"/>')
        cv.add(f'<rect x="{x0 + 82}" y="{y - 25}" width="{xe - x0 - 82}" height="50" rx="25" fill="{c[bar]}"/>')
    # The stale row is struck through.
    cv.add(f'<path d="M{x0 - 6} 348H{x1 + 6}" stroke="{c["ink"]}" stroke-width="16" stroke-linecap="round"/>')
    return cv.render("notebooklm-curator", "App icon: three source rows, the fresh one marked green, the stale one struck through.")


def main():
    fonts = {k: Font(v[0]) for k, v in FONTS.items()}
    for theme, colors in THEMES.items():
        (DOCS / f"hero-{theme}.svg").write_text(hero_desktop(fonts, colors), encoding="utf-8")
        (DOCS / f"hero-mobile-{theme}.svg").write_text(hero_mobile(fonts, colors), encoding="utf-8")
        (DOCS / f"demo-{theme}.svg").write_text(demo(fonts, colors), encoding="utf-8")
    (ART / "social-preview.svg").write_text(social(fonts, THEMES["dark"]), encoding="utf-8")
    (ART / "icon.svg").write_text(icon(fonts, THEMES["dark"]), encoding="utf-8")


if __name__ == "__main__":
    main()
