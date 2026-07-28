"""The Preciado Tech mark, for the Pygame side.

The glyph is defined once on a 64x64 grid and shared with the browser port
(web/src/lib/brand.ts), so a clip recorded by the CLI and a clip recorded in
the browser carry the same signature rather than two lookalikes.

There it is a path with an even-odd counter; here it is the same shape
decomposed into axis-aligned rectangles, because every edge in the glyph is
axis-aligned and rectangles need no polygon fill with a hole in it:

    body    = [10,44]x[12,40] u [10,22]x[12,54]
    counter = [22,36]x[21,27] u [22,31]x[27,31]
    body - counter = the five rectangles below
"""

CYAN = (92, 225, 242)
INK = (238, 246, 251)

# (x, y, w, h) on the 64x64 grid.
MARK_RECTS = (
    (10, 12, 12, 42),   # stem, full height
    (22, 12, 22, 9),    # top bar
    (36, 21, 8, 6),     # right side, beside the counter
    (31, 27, 13, 4),    # right side, beside the counter's step
    (22, 31, 22, 9),    # bottom bar of the bowl
)
NODE = (46, 13, 5)      # cx, cy, r


def draw_mark(surface, x, y, size, ink=INK, node=CYAN, alpha=255):
    """Blit the mark onto `surface` with its top-left at (x, y)."""
    import pygame

    s = size / 64.0
    glyph = pygame.Surface((size, size), pygame.SRCALPHA)
    for rx, ry, rw, rh in MARK_RECTS:
        pygame.draw.rect(
            glyph, (*ink, alpha),
            pygame.Rect(round(rx * s), round(ry * s),
                        max(1, round(rw * s)), max(1, round(rh * s))))

    cx, cy, r = NODE
    # A cheap two-pass bloom: a wide translucent disc under a solid one.
    pygame.draw.circle(glyph, (*node, alpha // 4),
                       (round(cx * s), round(cy * s)), max(2, round(r * s * 1.9)))
    pygame.draw.circle(glyph, (*node, alpha),
                       (round(cx * s), round(cy * s)), max(1, round(r * s)))
    surface.blit(glyph, (x, y))


_FONT_CACHE = {}


def _font(size):
    import pygame

    if size not in _FONT_CACHE:
        pygame.font.init()
        try:
            _FONT_CACHE[size] = pygame.font.SysFont(
                "dejavusansmono,menlo,consolas,monospace", size, bold=True)
        except Exception:                       # no system fonts available
            _FONT_CACHE[size] = pygame.font.Font(None, size)
    return _FONT_CACHE[size]


def draw_watermark(surface, corner="br", opacity=0.62, scale=0.038,
                   wordmark=True):
    """Sign a frame in the corner.

    Sized from the surface rather than in fixed pixels, so a 640px preview
    and a 1536px recording carry a watermark of the same visual weight.
    Mirrors drawWatermark() in web/src/lib/brand.ts.
    """
    import pygame

    w, h = surface.get_size()
    short = min(w, h)
    glyph = max(11, round(short * scale))
    pad = max(6, round(glyph * 0.5))
    gap = round(glyph * 0.42)
    alpha = int(255 * opacity)

    font = _font(max(7, round(glyph * 0.34)))
    label = font.render("PRECIADO TECH", True, (232, 244, 250)) if wordmark else None
    text_w = label.get_width() if label else 0

    plate_w = pad + glyph + (gap + text_w if wordmark else 0) + pad
    plate_h = glyph + round(pad * 1.5)
    margin = max(8, round(short * 0.022))
    px = w - margin - plate_w if corner in ("br", "tr") else margin
    py = h - margin - plate_h if corner in ("br", "bl") else margin

    plate = pygame.Surface((plate_w, plate_h), pygame.SRCALPHA)
    radius = max(2, round(plate_h * 0.32))
    pygame.draw.rect(plate, (6, 10, 14, int(115 * opacity / 0.62)),
                     plate.get_rect(), border_radius=radius)
    pygame.draw.rect(plate, (92, 225, 242, int(56 * opacity / 0.62)),
                     plate.get_rect(), width=1, border_radius=radius)
    surface.blit(plate, (px, py))

    draw_mark(surface, px + pad, py + (plate_h - glyph) // 2, glyph, alpha=alpha)
    if label:
        label.set_alpha(alpha)
        surface.blit(label, (px + pad + glyph + gap,
                             py + (plate_h - label.get_height()) // 2))
