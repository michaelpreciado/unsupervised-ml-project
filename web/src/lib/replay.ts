/** Live replay of the k-means fit.
 *
 * The worker keeps a snapshot of every Lloyd iteration of the winning
 * restart (centroids in the run's PCA plane + each tile's cluster). This
 * plays them back as the two alternating steps the algorithm is made of:
 *
 *   assign  — every library tile is tethered to its nearest centre;
 *   update  — each centre glides to the mean of the tiles tethered to it.
 *
 * Tiles are dots at their true mean colour, centres are cyan crosses with a
 * trail behind them, and the hollow rings are where k-means++ first put the
 * centres. It is the same data as the static convergence chart, made to move
 * so that "the centres stop moving" is something you can see happen. */

import type { KMeansStep } from './kmeans';
import type { Scatter } from './types';

const CYAN = '#5ce1f2';

export interface ReplayState {
  /** Fractional iteration being shown, 0..frames-1. */
  t: number;
  iteration: number;
  frames: number;
  inertia: number;
  moved: number;
  playing: boolean;
}

export interface Replay {
  setData: (scatter: Scatter | null, tileColors: Uint8Array, trace: KMeansStep[], k: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  resize: () => void;
  state: () => ReplayState;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

export function createReplay(
  canvas: HTMLCanvasElement,
  opts: { reducedMotion: () => boolean; onChange: (s: ReplayState) => void },
): Replay {
  const ctx = canvas.getContext('2d')!;
  let scatter: Scatter | null = null;
  let colors: Uint8Array = new Uint8Array(0);
  let trace: KMeansStep[] = [];
  let k = 0;
  let t = 0;
  let playing = false;
  let raf = 0;
  let lastNow = 0;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  // Plot transform.
  let minX = 0;
  let minY = 0;
  let sc = 1;
  let offX = 0;
  let offY = 0;

  const frames = () => scatter?.frames.length ?? 0;

  function measure() {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
    if (!w) return false;
    cssW = w;
    cssH = Math.round(Math.min(460, Math.max(240, w / 2.1)));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
    fitBounds();
    return true;
  }

  function fitBounds() {
    if (!scatter) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const eat = (a: Float32Array) => {
      for (let i = 0; i < a.length; i += 2) {
        x0 = Math.min(x0, a[i]);
        x1 = Math.max(x1, a[i]);
        y0 = Math.min(y0, a[i + 1]);
        y1 = Math.max(y1, a[i + 1]);
      }
    };
    eat(scatter.tiles);
    scatter.frames.forEach((f) => eat(f.centroids));
    const pad = 26;
    const spanX = Math.max(1e-6, x1 - x0);
    const spanY = Math.max(1e-6, y1 - y0);
    sc = Math.min((cssW - pad * 2) / spanX, (cssH - pad * 2) / spanY);
    minX = x0;
    minY = y0;
    offX = (cssW - spanX * sc) / 2;
    offY = (cssH - spanY * sc) / 2;
  }

  const px = (x: number) => offX + (x - minX) * sc;
  const py = (y: number) => cssH - (offY + (y - minY) * sc);

  function centroidAt(fi: number, phase: number, c: number): [number, number] {
    const a = scatter!.frames[fi].centroids;
    const b = scatter!.frames[Math.min(frames() - 1, fi + 1)].centroids;
    const e = smooth(phase);
    return [a[c * 2] + (b[c * 2] - a[c * 2]) * e, a[c * 2 + 1] + (b[c * 2 + 1] - a[c * 2 + 1]) * e];
  }

  function draw() {
    if (!cssW && !measure()) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!scatter || !frames()) return;

    const n = frames();
    const fi = Math.min(n - 1, Math.floor(t));
    const f = t - fi;
    // First 35% of each iteration is the assignment, the rest the glide.
    const phase = fi >= n - 1 ? 0 : Math.max(0, Math.min(1, (f - 0.35) / 0.65));
    const labels = scatter.frames[fi].labels;

    const cur: [number, number][] = [];
    for (let c = 0; c < k; c++) cur.push(centroidAt(fi, phase, c));

    // Tethers, one batched path per cluster would need k strokes; a single
    // path at low alpha is enough and cheaper.
    ctx.strokeStyle = 'rgba(92, 225, 242, 0.11)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const tiles = scatter.tiles;
    const count = tiles.length / 2;
    for (let i = 0; i < count; i++) {
      const [cx, cy] = cur[labels[i]] ?? cur[0];
      ctx.moveTo(px(tiles[i * 2]), py(tiles[i * 2 + 1]));
      ctx.lineTo(px(cx), py(cy));
    }
    ctx.stroke();

    // Tiles at their true colour.
    for (let i = 0; i < count; i++) {
      ctx.fillStyle = `rgb(${colors[i * 3]},${colors[i * 3 + 1]},${colors[i * 3 + 2]})`;
      ctx.beginPath();
      ctx.arc(px(tiles[i * 2]), py(tiles[i * 2 + 1]), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Seeding rings + trails + centres.
    const first = scatter.frames[0].centroids;
    for (let c = 0; c < k; c++) {
      ctx.strokeStyle = 'rgba(92, 225, 242, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px(first[c * 2]), py(first[c * 2 + 1]), 4.5, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(92, 225, 242, 0.55)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let j = 0; j <= fi; j++) {
        const a = scatter.frames[j].centroids;
        const x = px(a[c * 2]);
        const y = py(a[c * 2 + 1]);
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(px(cur[c][0]), py(cur[c][1]));
      ctx.stroke();
    }
    for (let c = 0; c < k; c++) {
      const x = px(cur[c][0]);
      const y = py(cur[c][1]);
      // Dark keyline then cyan cross, so it reads over any tile colour.
      for (const [w, style] of [[4.2, 'rgba(4,6,10,0.85)'], [2, CYAN]] as const) {
        ctx.strokeStyle = style;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(x - 7, y);
        ctx.lineTo(x + 7, y);
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x, y + 7);
        ctx.stroke();
      }
    }
  }

  function emit() {
    const n = frames();
    const fi = Math.min(n - 1, Math.floor(t));
    const step = trace[Math.min(trace.length - 1, fi)];
    opts.onChange({
      t,
      iteration: fi + 1,
      frames: n,
      inertia: scatter?.frames[fi]?.inertia ?? 0,
      moved: step?.moved ?? 0,
      playing,
    });
  }

  function tick(now: number) {
    if (!playing) return;
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;
    const n = frames();
    // Whole replay lasts about 6 s however many iterations it took.
    const perIter = Math.max(0.14, Math.min(0.9, 6 / Math.max(1, n)));
    t += dt / perIter;
    if (t >= n - 1) {
      t = n - 1;
      playing = false;
    }
    draw();
    emit();
    if (playing) raf = requestAnimationFrame(tick);
  }

  const api: Replay = {
    setData(s, tileColors, tr, kk) {
      scatter = s;
      colors = tileColors;
      trace = tr;
      k = kk;
      playing = false;
      cancelAnimationFrame(raf);
      t = s ? Math.max(0, s.frames.length - 1) : 0;
      if (measure()) draw();
      emit();
    },
    play() {
      const n = frames();
      if (n < 2) return;
      if (opts.reducedMotion()) {
        t = n - 1;
        draw();
        emit();
        return;
      }
      if (t >= n - 1) t = 0;
      playing = true;
      lastNow = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      emit();
    },
    pause() {
      playing = false;
      cancelAnimationFrame(raf);
      emit();
    },
    toggle() {
      if (playing) api.pause();
      else api.play();
    },
    seek(v) {
      playing = false;
      cancelAnimationFrame(raf);
      t = Math.max(0, Math.min(frames() - 1, v));
      draw();
      emit();
    },
    resize() {
      if (measure()) draw();
    },
    state: () => ({
      t,
      iteration: Math.min(frames(), Math.floor(t) + 1),
      frames: frames(),
      inertia: scatter?.frames[Math.min(frames() - 1, Math.floor(t))]?.inertia ?? 0,
      moved: 0,
      playing,
    }),
  };
  return api;
}
