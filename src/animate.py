"""Milestone 8: Pygame animation — tiles fly from scattered start
positions into their final mosaic slots, with staggered ease-out motion."""

import random

import pygame


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


def animate(choice, tiles, rows, cols, tile_size,
            duration=1.6, stagger=2.5, seed=42, auto_quit=False,
            max_window=(1280, 760)):
    """Play the fly-in animation. Esc or closing the window exits;
    auto_quit exits as soon as the animation completes (for testing)."""
    full_w, full_h = cols * tile_size, rows * tile_size
    scale = min(1.0, max_window[0] / full_w, max_window[1] / full_h)
    w, h = round(full_w * scale), round(full_h * scale)
    ts = max(1, round(tile_size * scale))

    pygame.init()
    screen = pygame.display.set_mode((w, h))
    pygame.display.set_caption("mosaic — unsupervised photo mosaic")
    clock = pygame.time.Clock()

    # One scaled surface per unique tile (tiles repeat across the grid).
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
        delay = rng.uniform(0.0, stagger)
        sprites.append((start, final, delay, int(tile_index)))
    # Draw in delay order so tiles still flying pass over ones already placed.
    sprites.sort(key=lambda s: s[2])

    t0 = pygame.time.get_ticks()
    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT or (
                event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE
            ):
                running = False

        now = (pygame.time.get_ticks() - t0) / 1000.0
        screen.fill((12, 12, 16))
        for (sx, sy), (fx, fy), delay, tile_index in sprites:
            p = min(1.0, max(0.0, (now - delay) / duration))
            e = _ease_out_cubic(p)
            x = sx + (fx - sx) * e
            y = sy + (fy - sy) * e
            screen.blit(surf_cache[tile_index], (round(x), round(y)))
        pygame.display.flip()

        if auto_quit and now > stagger + duration + 0.25:
            running = False
        clock.tick(60)

    pygame.quit()
