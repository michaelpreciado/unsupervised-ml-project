"""Milestone 8: Pygame animation — tiles fly from scattered start
positions into their final mosaic slots, with staggered ease-out motion.

Two entry points share one frame renderer:

- animate() plays it in a window, driven by the wall clock.
- record() renders the same timeline headlessly at a fixed timestep and
  writes a video file. Fixed timestep matters: a recording made this way is
  reproducible frame for frame, where one captured from a live window would
  depend on how busy the machine was.

The stagger is mostly a diagonal sweep across the grid with a little jitter
on top — ordered enough to read as construction, disordered enough not to
look like a wipe — which is the same schedule the browser port uses. The
browser additionally spins each tile as it flies; that needs a per-sprite
rotozoom here and doesn't hold 60 fps at a few thousand sprites, so this
version keeps the translation and the cyan flight tint only.
"""

import random

import pygame

from .brand import draw_watermark

BACKDROP = (5, 7, 11)
HEAT = (92, 225, 242)


def _ease_out_cubic(t):
    return 1.0 - (1.0 - t) ** 3


def _scatter_start(rng, w, h):
    """Random point just outside a random edge of the window."""
    edge = rng.randrange(4)
    m = 80  # how far off-screen tiles start
    if edge == 0:
        return rng.uniform(-m, w), -m
    if edge == 1:
        return rng.uniform(-m, w), h + m
    if edge == 2:
        return -m, rng.uniform(-m, h)
    return w + m, rng.uniform(-m, h)


def _build(choice, tiles, rows, cols, tile_size, w, h, scale, ts, seed, stagger):
    """One scaled surface per unique tile, plus a flight plan per cell."""
    surf_cache = {}
    for tile_index in set(int(i) for i in choice):
        arr = tiles[tile_index]
        surf = pygame.image.frombytes(
            arr.tobytes(), (tile_size, tile_size), "RGB")
        surf_cache[tile_index] = pygame.transform.smoothscale(surf, (ts, ts))

    rng = random.Random(seed)
    sprites = []  # (start_xy, final_xy, delay, tile_index)
    for i, tile_index in enumerate(choice):
        r, c = divmod(i, cols)
        final = (round(c * tile_size * scale), round(r * tile_size * scale))
        start = _scatter_start(rng, w, h)
        wave = (c / max(1, cols - 1)) * 0.6 + (r / max(1, rows - 1)) * 0.4
        delay = (wave * 0.75 + rng.random() * 0.25) * stagger
        sprites.append((start, final, delay, int(tile_index)))
    # Draw in delay order so tiles still flying pass over ones already placed.
    sprites.sort(key=lambda s: s[2])
    return surf_cache, sprites


def _draw_frame(screen, sprites, surf_cache, now, duration, ts, watermark=True):
    screen.fill(BACKDROP)
    for (sx, sy), (fx, fy), delay, tile_index in sprites:
        p = min(1.0, max(0.0, (now - delay) / duration))
        if p <= 0.0:
            continue
        e = _ease_out_cubic(p)
        x = round(sx + (fx - sx) * e)
        y = round(sy + (fy - sy) * e)
        screen.blit(surf_cache[tile_index], (x, y))
        if p < 1.0:
            # Additive cyan that fades out as the tile lands, so motion is
            # legible and the frame cools into true colour.
            k = (1.0 - e) * 0.34
            screen.fill(tuple(round(v * k) for v in HEAT),
                        pygame.Rect(x, y, ts, ts),
                        special_flags=pygame.BLEND_RGB_ADD)
    if watermark:
        draw_watermark(screen)


def _layout(rows, cols, tile_size, max_window):
    full_w, full_h = cols * tile_size, rows * tile_size
    scale = min(1.0, max_window[0] / full_w, max_window[1] / full_h)
    w, h = round(full_w * scale), round(full_h * scale)
    return w, h, scale, max(1, round(tile_size * scale))


def animate(choice, tiles, rows, cols, tile_size,
            duration=1.6, stagger=2.5, seed=42, auto_quit=False,
            max_window=(1280, 760), watermark=True):
    """Play the fly-in animation. Esc or closing the window exits;
    auto_quit exits as soon as the animation completes (for testing)."""
    w, h, scale, ts = _layout(rows, cols, tile_size, max_window)

    pygame.init()
    screen = pygame.display.set_mode((w, h))
    pygame.display.set_caption("Preciado Mosaic — unsupervised photo mosaic")
    clock = pygame.time.Clock()

    surf_cache, sprites = _build(
        choice, tiles, rows, cols, tile_size, w, h, scale, ts, seed, stagger)

    t0 = pygame.time.get_ticks()
    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT or (
                event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE
            ):
                running = False

        now = (pygame.time.get_ticks() - t0) / 1000.0
        _draw_frame(screen, sprites, surf_cache, now, duration, ts, watermark)
        pygame.display.flip()

        if auto_quit and now > stagger + duration + 0.25:
            running = False
        clock.tick(60)

    pygame.quit()


def record(choice, tiles, rows, cols, tile_size, out_path,
           duration=1.6, stagger=2.5, seed=42, fps=60, hold=1.2,
           max_window=(1280, 760), watermark=True):
    """Render the animation to a video file, headlessly and deterministically.

    Writes an MP4 when imageio is installed (`pip install "imageio[ffmpeg]"`)
    and falls back to a numbered PNG sequence otherwise, printing the ffmpeg
    command that stitches it. Returns the path actually written.
    """
    from pathlib import Path

    out_path = Path(out_path)
    w, h, scale, ts = _layout(rows, cols, tile_size, max_window)

    # No display is opened: everything lands on an off-screen Surface, so
    # this works over SSH and in CI.
    pygame.init()
    canvas = pygame.Surface((w, h))
    surf_cache, sprites = _build(
        choice, tiles, rows, cols, tile_size, w, h, scale, ts, seed, stagger)

    total = stagger + duration + hold
    frame_count = int(round(total * fps))

    def frames():
        for n in range(frame_count):
            _draw_frame(canvas, sprites, surf_cache, n / fps, duration, ts,
                        watermark)
            # pygame gives (w, h, 3) column-major; video wants (h, w, 3).
            yield pygame.surfarray.array3d(canvas).swapaxes(0, 1)

    try:
        import imageio.v2 as imageio
    except ImportError:
        imageio = None

    if imageio is not None and out_path.suffix.lower() in (".mp4", ".webm", ".gif"):
        with imageio.get_writer(out_path, fps=fps, macro_block_size=None) as writer:
            for frame in frames():
                writer.append_data(frame)
        pygame.quit()
        return out_path

    folder = out_path.with_suffix("") if out_path.suffix else out_path
    folder.mkdir(parents=True, exist_ok=True)
    for n, frame in enumerate(frames()):
        pygame.image.save(
            pygame.surfarray.make_surface(frame.swapaxes(0, 1)),
            str(folder / f"frame_{n:05d}.png"))
    pygame.quit()
    print(f"wrote {frame_count} frames to {folder}/ "
          f'(install "imageio[ffmpeg]" to get an mp4 directly, or run:\n'
          f"  ffmpeg -framerate {fps} -i {folder}/frame_%05d.png "
          f"-c:v libx264 -pix_fmt yuv420p {folder}.mp4)")
    return folder
