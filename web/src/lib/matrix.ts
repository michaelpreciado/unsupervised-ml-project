/** The backdrop: a slow blue glyph rain behind the glass.
 *
 * Three rules keep it from becoming noise. It runs at a fraction of the
 * display refresh (the glyphs are meant to drift, not strobe), it is masked
 * away from the centre column in CSS so body text never sits on top of a
 * moving character, and it stops entirely when the tab is hidden, scrolled
 * out of use, or the visitor has asked for reduced motion.
 *
 * It also answers the pointer: glyphs near the cursor light up toward white
 * cyan and part sideways around it, like a hand through falling text. The
 * pointer only raises the frame rate while it is actually moving. */

const GLYPHS = 'ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789ABCDEF<>/\\[]{}=+*·';
const FONT_SIZE = 15;
const COLUMN_W = FONT_SIZE * 1.35;
/** Frames per second. Low on purpose: the rain reads as ambient at 14 fps
 * and as a screensaver at 60. */
const FPS = 14;
/** Paint rate while the pointer is stirring the field. */
const ACTIVE_FPS = 30;
const POINTER_RADIUS = 150;
const PALETTE_STEPS = 14;

/** Trail colours are quantised once, not formatted per glyph per frame. */
const TRAIL = Array.from({ length: PALETTE_STEPS }, (_, n) => {
  const t = n / (PALETTE_STEPS - 1);
  return `rgba(64, ${Math.round(150 - t * 60)}, ${Math.round(210 - t * 60)}, ${(0.5 * (1 - t) ** 1.6).toFixed(3)})`;
});
const HEAD = 'rgba(150, 245, 255, 0.95)';

interface Column {
  /** Head position, in rows. */
  y: number;
  speed: number;
  /** Rows of trail behind the head. */
  length: number;
  /** Glyphs are resampled occasionally rather than every frame, so a
   * column reads as falling text rather than static. */
  chars: string[];
}

export interface RainHandle {
  destroy: () => void;
}

function pick(): string {
  return GLYPHS[(Math.random() * GLYPHS.length) | 0];
}

function makeColumn(rows: number, seeded: boolean): Column {
  const length = 6 + ((Math.random() * 18) | 0);
  return {
    y: seeded ? Math.random() * rows : -length,
    speed: 0.22 + Math.random() * 0.55,
    length,
    chars: Array.from({ length }, pick),
  };
}

export function startRain(canvas: HTMLCanvasElement): RainHandle {
  const ctx = canvas.getContext('2d', { alpha: true })!;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let columns: Column[] = [];
  let cols = 0;
  let rows = 0;
  let dpr = 1;
  let raf = 0;
  let last = 0;
  let running = false;
  // Pointer in CSS px; `sx/sy` chase it so the halo glides.
  let px = -9999;
  let py = -9999;
  let sx = -9999;
  let sy = -9999;
  let lastMove = -1e9;
  let lastAdvance = 0;

  function resize() {
    // Glyphs are soft, 1.5x is indistinguishable from 2x and ~44% cheaper.
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${FONT_SIZE}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = 'top';

    cols = Math.ceil(w / COLUMN_W);
    rows = Math.ceil(h / FONT_SIZE) + 2;
    columns = Array.from({ length: cols }, () => makeColumn(rows, true));
    if (!running) paint(false);
  }

  /** One pass. `advance` moves the columns on; without it the field is
   * redrawn in place — the reduced-motion rendering, and the in-between
   * frames where only the pointer halo is moving. */
  function paint(advance: boolean) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const R2 = POINTER_RADIUS * POINTER_RADIUS;
    const near = sx > -1000;

    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      const x = c * COLUMN_W;
      for (let i = 0; i < col.length; i++) {
        const row = Math.floor(col.y) - i;
        if (row < 0 || row > rows) continue;
        const t = i / col.length;
        const y = row * FONT_SIZE;
        let gx = x;
        let lift = 0;
        if (near) {
          const dx = x - sx;
          const dy = y - sy;
          const d2 = dx * dx + dy * dy;
          if (d2 < R2) {
            lift = 1 - Math.sqrt(d2) / POINTER_RADIUS;
            lift *= lift;
            gx = x + Math.sign(dx || 1) * lift * 16;
          }
        }
        if (lift > 0.02) {
          const a = Math.min(1, 0.55 * (1 - t) ** 1.2 + lift * 0.9);
          ctx.fillStyle = `rgba(${170 + Math.round(lift * 60)}, 248, 255, ${a.toFixed(2)})`;
        } else {
          ctx.fillStyle = i === 0 ? HEAD : TRAIL[Math.min(PALETTE_STEPS - 1, (t * PALETTE_STEPS) | 0)];
        }
        ctx.fillText(col.chars[i], gx, y);
      }

      if (!advance) continue;
      col.y += col.speed;
      // Churn one glyph per column per frame — enough to feel alive
      // without the whole column flickering.
      col.chars[(Math.random() * col.length) | 0] = pick();
      if (col.y - col.length > rows) columns[c] = makeColumn(rows, false);
    }
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const active = now - lastMove < 1200;
    if (now - last < 1000 / (active ? ACTIVE_FPS : FPS)) return;
    last = now;
    if (active) {
      sx += (px - sx) * 0.35;
      sy += (py - sy) * 0.35;
    }
    const advance = now - lastAdvance >= 1000 / FPS - 2;
    if (advance) lastAdvance = now;
    paint(advance);
  }

  function onPointer(e: PointerEvent) {
    px = e.clientX;
    py = e.clientY;
    if (sx < -1000) {
      sx = px;
      sy = py;
    }
    lastMove = performance.now();
  }

  function onLeave() {
    px = py = sx = sy = -9999;
    lastMove = -1e9;
    if (!running) paint(false);
  }

  function sync() {
    const shouldRun = !reduced.matches && !document.hidden;
    if (shouldRun === running) return;
    running = shouldRun;
    if (running) {
      last = 0;
      raf = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(raf);
      paint(false);
    }
  }

  resize();
  sync();
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onLeave);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
    },
  };
}
