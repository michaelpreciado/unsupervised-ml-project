/** The backdrop: a slow blue glyph rain behind the glass.
 *
 * Three rules keep it from becoming noise. It runs at a fraction of the
 * display refresh (the glyphs are meant to drift, not strobe), it is masked
 * away from the centre column in CSS so body text never sits on top of a
 * moving character, and it stops entirely when the tab is hidden or the
 * visitor has asked for reduced motion. */

const GLYPHS = 'ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789ABCDEF<>/\\[]{}=+*·';
const FONT_SIZE = 15;
const COLUMN_W = FONT_SIZE * 1.35;
/** Frames per second. Low on purpose: the rain reads as ambient at 14 fps
 * and as a screensaver at 60. */
const FPS = 14;

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

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
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
    if (!running) paint(true);
  }

  /** One pass. `still` draws the field without advancing it — used for the
   * reduced-motion rendering, which gets the texture but none of the drift. */
  function paint(still: boolean) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      const x = c * COLUMN_W;
      for (let i = 0; i < col.length; i++) {
        const row = Math.floor(col.y) - i;
        if (row < 0 || row > rows) continue;
        const t = i / col.length;
        const head = i === 0;
        // The head is a lit node in brand cyan; the trail falls away to a
        // deep blue that all but disappears against the background.
        ctx.fillStyle = head
          ? 'rgba(150, 245, 255, 0.95)'
          : `rgba(64, ${Math.round(150 - t * 60)}, ${Math.round(210 - t * 60)}, ${(0.5 * (1 - t) ** 1.6).toFixed(3)})`;
        ctx.fillText(col.chars[i], x, row * FONT_SIZE);
      }

      if (still) continue;
      col.y += col.speed;
      // Churn one glyph per column per frame — enough to feel alive
      // without the whole column flickering.
      col.chars[(Math.random() * col.length) | 0] = pick();
      if (col.y - col.length > rows) columns[c] = makeColumn(rows, false);
    }
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / FPS) return;
    last = now;
    paint(false);
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
      paint(true);
    }
  }

  resize();
  sync();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
    },
  };
}
