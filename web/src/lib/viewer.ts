/** Deep-zoom viewer for the finished mosaic.
 *
 * Two levels of detail, chosen per frame from the on-screen size of one cell:
 *
 * - **Far** (a cell is under ~28 px): the mosaic is already painted into one
 *   canvas at native tile resolution, so the whole view is a single
 *   drawImage of the visible window. Cost is independent of how many cells
 *   there are.
 * - **Near**: only the cells that intersect the viewport are drawn, each
 *   straight from the library's high-resolution sprite sheet. Nothing off
 *   screen is touched — the virtualisation is the loop bounds — so a 96 x 64
 *   grid zoomed to a 6 x 4 window is 24 sprite blits, and each one is a real
 *   64 px photo rather than a 16 px tile blown up.
 *
 * Rendering is on demand (a rAF is only scheduled when the camera moves), so
 * an idle viewer costs nothing. Input: drag to pan, wheel / pinch / buttons
 * to zoom, double-click to zoom in, arrow keys + / - / 0 from the keyboard. */

import type { Lod } from './tiles';

export interface ViewerData {
  /** The finished mosaic at native resolution (cols*tile x rows*tile). */
  mosaic: HTMLCanvasElement;
  choice: Int32Array;
  cellCluster: Int32Array;
  cellMeans: Uint8Array;
  rows: number;
  cols: number;
  tileSize: number;
  lod: Lod | null;
}

export interface CellInfo {
  row: number;
  col: number;
  tile: number;
  cluster: number;
}

export interface Viewer {
  setData: (data: ViewerData | null) => void;
  /** Dim every cell not routed to this cluster; null clears. */
  setIsolate: (cluster: number | null) => void;
  resize: () => void;
  zoomBy: (factor: number) => void;
  reset: (animated?: boolean) => void;
  /** Cinematic fly-in to the brightest cell and back out. */
  dive: () => Promise<void>;
  isDiving: () => boolean;
  /** Repaint from scratch (after theme/size changes). */
  invalidate: () => void;
  scale: () => number;
}

const NEAR_CELL_PX = 28;
const MAX_CELL_PX = 260;
const BACKDROP = '#05070b';

export function createViewer(
  canvas: HTMLCanvasElement,
  hud: HTMLElement,
  opts: { reducedMotion: () => boolean; onCell?: (info: CellInfo | null) => void },
): Viewer {
  const ctx = canvas.getContext('2d')!;
  let data: ViewerData | null = null;
  let isolate: number | null = null;

  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  // Camera: mosaic-pixel coordinate at the viewport centre, and css px per
  // mosaic px.
  let cx = 0;
  let cy = 0;
  let scale = 1;
  let fit = 1;
  let raf = 0;
  let diving = false;
  let tween: number | null = null;
  let hoverCell: CellInfo | null = null;

  const mw = () => (data ? data.cols * data.tileSize : 1);
  const mh = () => (data ? data.rows * data.tileSize : 1);
  const maxScale = () => (data ? MAX_CELL_PX / data.tileSize : 1);

  function measure() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, Math.round(rect.width));
    cssH = Math.max(1, Math.round(rect.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (data) {
      const wasFit = Math.abs(scale - fit) < 1e-6;
      fit = Math.min(cssW / mw(), cssH / mh());
      if (wasFit || scale < fit) scale = fit;
      clamp();
    }
  }

  function clamp() {
    scale = Math.min(maxScale(), Math.max(fit, scale));
    // Keep the mosaic covering the viewport, or centred if it is smaller.
    const halfW = cssW / 2 / scale;
    const halfH = cssH / 2 / scale;
    cx = mw() * scale <= cssW ? mw() / 2 : Math.min(mw() - halfW, Math.max(halfW, cx));
    cy = mh() * scale <= cssH ? mh() / 2 : Math.min(mh() - halfH, Math.max(halfH, cy));
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(paint);
  }

  const toMosaic = (sx: number, sy: number): [number, number] => [
    cx + (sx - cssW / 2) / scale,
    cy + (sy - cssH / 2) / scale,
  ];

  function cellAt(sx: number, sy: number): CellInfo | null {
    if (!data) return null;
    const [mx, my] = toMosaic(sx, sy);
    const col = Math.floor(mx / data.tileSize);
    const row = Math.floor(my / data.tileSize);
    if (col < 0 || row < 0 || col >= data.cols || row >= data.rows) return null;
    const i = row * data.cols + col;
    return { row, col, tile: data.choice[i], cluster: data.cellCluster[i] };
  }

  function paint() {
    raf = 0;
    if (!cssW) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, cssW, cssH);
    if (!data) return;

    const t = data.tileSize;
    const cellPx = t * scale;
    const left = cx - cssW / 2 / scale;
    const top = cy - cssH / 2 / scale;
    const ox = -left * scale;
    const oy = -top * scale;
    const near = !!data.lod && cellPx > NEAR_CELL_PX;

    if (!near) {
      // Far: one blit of the visible window. Pixelated when magnified a
      // little so tile edges stay honest; smoothed when minified.
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(data.mosaic, ox, oy, mw() * scale, mh() * scale);
    } else {
      const lod = data.lod!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const c0 = Math.max(0, Math.floor(left / t));
      const c1 = Math.min(data.cols - 1, Math.floor((left + cssW / scale) / t));
      const r0 = Math.max(0, Math.floor(top / t));
      const r1 = Math.min(data.rows - 1, Math.floor((top + cssH / scale) / t));
      // Bleed by a hair so adjacent sprites never leave a seam.
      const bleed = 0.35;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = data.choice[r * data.cols + c];
          ctx.drawImage(
            lod.source,
            (idx % lod.cols) * lod.size,
            Math.floor(idx / lod.cols) * lod.size,
            lod.size,
            lod.size,
            ox + c * cellPx - bleed,
            oy + r * cellPx - bleed,
            cellPx + bleed * 2,
            cellPx + bleed * 2,
          );
        }
      }
    }

    if (isolate !== null) {
      const c0 = Math.max(0, Math.floor(left / t));
      const c1 = Math.min(data.cols - 1, Math.floor((left + cssW / scale) / t));
      const r0 = Math.max(0, Math.floor(top / t));
      const r1 = Math.min(data.rows - 1, Math.floor((top + cssH / scale) / t));
      ctx.fillStyle = 'rgba(4, 6, 10, 0.8)';
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (data.cellCluster[r * data.cols + c] === isolate) continue;
          ctx.fillRect(ox + c * cellPx - 0.3, oy + r * cellPx - 0.3, cellPx + 0.6, cellPx + 0.6);
        }
      }
    }

    if (hoverCell && near) {
      ctx.strokeStyle = 'rgba(92, 225, 242, 0.95)';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + hoverCell.col * cellPx + 1, oy + hoverCell.row * cellPx + 1, cellPx - 2, cellPx - 2);
    }

    if (scale > fit * 1.08) drawMinimap(left, top);
    updateHud();
  }

  function drawMinimap(left: number, top: number) {
    if (!data) return;
    const w = Math.min(132, cssW * 0.28);
    const h = (w * mh()) / mw();
    const x = cssW - w - 12;
    const y = cssH - h - 12;
    ctx.fillStyle = 'rgba(4, 6, 10, 0.72)';
    ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(data.mosaic, x, y, w, h);
    ctx.strokeStyle = 'rgba(120, 214, 240, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 2.5, y - 2.5, w + 5, h + 5);
    const k = w / mw();
    const vx = Math.max(x, x + left * k);
    const vy = Math.max(y, y + top * k);
    const vw = Math.min(x + w, x + (left + cssW / scale) * k) - vx;
    const vh = Math.min(y + h, y + (top + cssH / scale) * k) - vy;
    ctx.strokeStyle = 'rgba(92, 225, 242, 1)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, Math.max(2, vw), Math.max(2, vh));
  }

  function updateHud() {
    if (!data) return;
    const zoom = scale / fit;
    const parts = [`${zoom.toFixed(1)}×`];
    if (hoverCell) {
      parts.push(`r${hoverCell.row} · c${hoverCell.col}`, `tile #${hoverCell.tile}`);
      if (hoverCell.cluster >= 0) parts.push(`cluster ${String(hoverCell.cluster).padStart(2, '0')}`);
    } else {
      parts.push(data.lod && data.tileSize * scale > NEAR_CELL_PX ? 'full-detail tiles' : 'native tiles');
    }
    hud.textContent = parts.join('  ·  ');
  }

  /** Zoom by `factor` keeping the mosaic point under (sx, sy) fixed. */
  function zoomAt(factor: number, sx: number, sy: number) {
    const [mx, my] = toMosaic(sx, sy);
    scale = Math.min(maxScale(), Math.max(fit, scale * factor));
    cx = mx - (sx - cssW / 2) / scale;
    cy = my - (sy - cssH / 2) / scale;
    clamp();
    schedule();
  }

  /* ------------------------------------------------------------- input */

  const pointers = new Map<number, { x: number; y: number }>();
  let lastPinch = 0;
  let moved = false;

  const local = (e: MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!data || diving) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    pointers.set(e.pointerId, { x, y });
    moved = false;
    lastPinch = 0;
    canvas.focus({ preventScroll: true });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!data) return;
    const [x, y] = local(e);
    const p = pointers.get(e.pointerId);
    if (!p) {
      const cell = cellAt(x, y);
      if (cell?.tile !== hoverCell?.tile || cell?.row !== hoverCell?.row || cell?.col !== hoverCell?.col) {
        hoverCell = cell;
        opts.onCell?.(cell);
        schedule();
      }
      return;
    }
    if (diving) return;
    if (pointers.size === 2) {
      pointers.set(e.pointerId, { x, y });
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch) zoomAt(dist / lastPinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      lastPinch = dist;
      moved = true;
      return;
    }
    const dx = x - p.x;
    const dy = y - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    p.x = x;
    p.y = y;
    cx -= dx / scale;
    cy -= dy / scale;
    clamp();
    schedule();
  });

  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    lastPinch = 0;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => {
    if (hoverCell) {
      hoverCell = null;
      opts.onCell?.(null);
      schedule();
    }
  });

  canvas.addEventListener('dblclick', (e) => {
    if (!data || diving || moved) return;
    const [x, y] = local(e);
    const target = scale >= maxScale() * 0.9 ? fit / scale : 2.4;
    animateCamera(...(() => {
      const [mx, my] = toMosaic(x, y);
      const s = Math.min(maxScale(), Math.max(fit, scale * target));
      return [mx, my, s] as [number, number, number];
    })(), 0.45);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!data || diving) return;
      // Only take the wheel once the visitor has engaged with the viewer, so
      // scrolling the page past it still works.
      const engaged = e.ctrlKey || e.metaKey || document.activeElement === canvas || scale > fit * 1.02;
      if (!engaged) return;
      e.preventDefault();
      const [x, y] = local(e);
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018)), x, y);
    },
    { passive: false },
  );

  canvas.addEventListener('keydown', (e) => {
    if (!data || diving) return;
    const step = 60 / scale;
    switch (e.key) {
      case 'ArrowLeft': cx -= step; break;
      case 'ArrowRight': cx += step; break;
      case 'ArrowUp': cy -= step; break;
      case 'ArrowDown': cy += step; break;
      case '+': case '=': zoomAt(1.4, cssW / 2, cssH / 2); e.preventDefault(); return;
      case '-': case '_': zoomAt(1 / 1.4, cssW / 2, cssH / 2); e.preventDefault(); return;
      case '0': api.reset(true); e.preventDefault(); return;
      default: return;
    }
    e.preventDefault();
    clamp();
    schedule();
  });

  /* ----------------------------------------------------------- camera */

  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  /** Tween to (x, y, s); scale is interpolated in log space so a zoom feels
   * constant-speed rather than lurching at the end. */
  function animateCamera(x: number, y: number, s: number, seconds: number): Promise<void> {
    if (tween !== null) cancelAnimationFrame(tween);
    if (opts.reducedMotion() || seconds <= 0) {
      cx = x;
      cy = y;
      scale = s;
      clamp();
      schedule();
      return Promise.resolve();
    }
    const [x0, y0, s0] = [cx, cy, scale];
    const start = performance.now();
    return new Promise((resolve) => {
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / (seconds * 1000));
        const e = ease(p);
        scale = Math.exp(Math.log(s0) + (Math.log(s) - Math.log(s0)) * e);
        // Move the centre along the same eased fraction of the *screen-space*
        // path, which keeps the target under the crosshair as we zoom.
        const k = (1 / scale - 1 / s0) / (1 / s - 1 / s0 || 1);
        const f = s === s0 ? e : k;
        cx = x0 + (x - x0) * f;
        cy = y0 + (y - y0) * f;
        clamp();
        paint();
        if (p < 1) tween = requestAnimationFrame(step);
        else {
          tween = null;
          resolve();
        }
      };
      tween = requestAnimationFrame(step);
    });
  }

  const api: Viewer = {
    setData(next) {
      data = next;
      hoverCell = null;
      isolate = null;
      if (data) {
        measure();
        scale = fit;
        cx = mw() / 2;
        cy = mh() / 2;
        clamp();
      }
      schedule();
    },
    setIsolate(cluster) {
      isolate = cluster;
      schedule();
    },
    resize() {
      measure();
      schedule();
    },
    zoomBy(factor) {
      zoomAt(factor, cssW / 2, cssH / 2);
    },
    reset(animated = true) {
      if (!data) return;
      void animateCamera(mw() / 2, mh() / 2, fit, animated ? 0.5 : 0);
    },
    async dive() {
      if (!data || diving) return;
      diving = true;
      try {
        // The brightest cell in the middle of the frame — for the demo
        // target that is the sun; for anything else, its focal highlight.
        let best = 0;
        let bestL = -1;
        for (let r = Math.floor(data.rows * 0.2); r < Math.ceil(data.rows * 0.8); r++) {
          for (let c = Math.floor(data.cols * 0.2); c < Math.ceil(data.cols * 0.8); c++) {
            const i = r * data.cols + c;
            const l = data.cellMeans[i * 3] * 0.3 + data.cellMeans[i * 3 + 1] * 0.59 + data.cellMeans[i * 3 + 2] * 0.11;
            if (l > bestL) {
              bestL = l;
              best = i;
            }
          }
        }
        const t = data.tileSize;
        const tx = ((best % data.cols) + 0.5) * t;
        const ty = (Math.floor(best / data.cols) + 0.5) * t;
        // Deep enough that ~5 cells span the viewport.
        const deep = Math.min(maxScale(), Math.max(fit * 3, cssW / (5 * t)));
        await animateCamera(mw() / 2, mh() / 2, fit, 0);
        await animateCamera(tx, ty, deep, 3.4);
        if (!opts.reducedMotion()) await new Promise((r) => setTimeout(r, 900));
        await animateCamera(mw() / 2, mh() / 2, fit, 2.4);
      } finally {
        diving = false;
        schedule();
      }
    },
    isDiving: () => diving,
    invalidate: schedule,
    scale: () => scale / fit,
  };
  return api;
}
