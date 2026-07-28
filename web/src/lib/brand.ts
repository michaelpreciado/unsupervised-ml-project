/** The Preciado Tech mark, defined once and drawn everywhere.
 *
 * The glyph is a blocky "P" — a stem, a bowl with a stepped counter, and a
 * lit node at the top-right corner. It exists in two forms here because it
 * has to live in two worlds: as SVG (page chrome, favicon) and as a Path2D
 * (baked into exported frames, where no DOM is available).
 *
 * Both are generated from the same path data on a 64×64 grid, so the
 * watermark burned into a saved video is the same shape as the one in the
 * header — not a redrawn approximation of it. */

/** Outer silhouette: stem down the left, bowl across the top. */
const MARK_BODY = 'M10 12 H44 V40 H22 V54 H10 Z';
/** The counter, cut out with the even-odd rule. The step on its lower right
 * is the detail that keeps the glyph from reading as a generic block P. */
const MARK_COUNTER = 'M22 21 H36 V27 H31 V31 H22 Z';

const NODE = { x: 46, y: 13, r: 5 } as const;

export const BRAND = {
  name: 'Preciado Tech',
  cyan: '#5ce1f2',
  cyanDim: '#2a9fb8',
  ink: '#f2f6fa',
} as const;

export interface MarkOptions {
  /** Colour of the glyph itself. */
  ink?: string;
  /** Colour of the lit node. */
  node?: string;
  /** Draw the soft bloom around the node. Off for tiny sizes, where the
   * blur costs more than it reads. */
  glow?: boolean;
}

/** The mark as a standalone SVG document — used for the favicon and for
 * inlining into the page header. */
export function markSvg(size = 64, { ink = '#fff', node = BRAND.cyan, glow = true }: MarkOptions = {}): string {
  const bloom = glow
    ? `<filter id="ptglow" x="-120%" y="-120%" width="340%" height="340%">
         <feGaussianBlur stdDeviation="3.4" result="b"/>
         <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
       </filter>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">
  <defs>${bloom}</defs>
  <path d="${MARK_BODY} ${MARK_COUNTER}" fill="${ink}" fill-rule="evenodd"/>
  <circle cx="${NODE.x}" cy="${NODE.y}" r="${NODE.r}" fill="${node}"${glow ? ' filter="url(#ptglow)"' : ''}/>
</svg>`;
}

/* ------------------------------------------------------------- canvas */

let bodyPath: Path2D | null = null;

function markPath(): Path2D {
  if (!bodyPath) bodyPath = new Path2D(`${MARK_BODY} ${MARK_COUNTER}`);
  return bodyPath;
}

/** Paint the mark into a 2D context, scaled so the 64×64 grid maps onto
 * `size` px with its top-left corner at (x, y). */
export function drawMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  { ink = '#fff', node = BRAND.cyan, glow = true }: MarkOptions = {},
): void {
  const s = size / 64;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);

  ctx.fillStyle = ink;
  ctx.fill(markPath(), 'evenodd');

  if (glow) {
    ctx.shadowColor = node;
    ctx.shadowBlur = 14;
  }
  ctx.fillStyle = node;
  ctx.beginPath();
  ctx.arc(NODE.x, NODE.y, NODE.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ---------------------------------------------------------- watermark */

export interface WatermarkOptions {
  /** Corner to sit in. */
  corner?: 'br' | 'bl' | 'tr' | 'tl';
  /** Overall opacity. Deliberately restrained — it should sign the frame,
   * not compete with it. */
  opacity?: number;
  /** Mark height as a fraction of the shorter canvas edge. */
  scale?: number;
  /** Include the "PRECIADO TECH" wordmark next to the glyph. */
  wordmark?: boolean;
}

/**
 * Sign a frame in the corner: the mark, the wordmark, and a hairline glass
 * plate behind them so it stays legible over both a white sky and a black
 * shadow.
 *
 * Sized from the canvas rather than in fixed pixels, so a 480 px preview
 * and a 1,536 px export carry a watermark of the same visual weight.
 */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  { corner = 'br', opacity = 0.62, scale = 0.038, wordmark = true }: WatermarkOptions = {},
): void {
  const short = Math.min(width, height);
  const glyph = Math.max(11, Math.round(short * scale));
  const pad = Math.max(6, Math.round(glyph * 0.5));
  const gap = Math.round(glyph * 0.42);
  const fontSize = Math.max(6, glyph * 0.3);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = `${(fontSize * 0.18).toFixed(2)}px`;

  const label = 'PRECIADO TECH';
  const textWidth = wordmark ? ctx.measureText(label).width : 0;
  const plateW = pad + glyph + (wordmark ? gap + textWidth : 0) + pad;
  const plateH = glyph + pad * 1.5;

  const margin = Math.max(8, Math.round(short * 0.022));
  const px = corner === 'br' || corner === 'tr' ? width - margin - plateW : margin;
  const py = corner === 'br' || corner === 'bl' ? height - margin - plateH : margin;

  // Glass plate: a dark wash plus a hairline, the same recipe as the
  // page's panels so the signature belongs to the same design system.
  const radius = plateH * 0.32;
  ctx.beginPath();
  ctx.roundRect(px, py, plateW, plateH, radius);
  ctx.fillStyle = 'rgba(6, 10, 14, 0.45)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, short * 0.0012);
  ctx.strokeStyle = 'rgba(92, 225, 242, 0.22)';
  ctx.stroke();

  const glyphY = py + (plateH - glyph) / 2;
  drawMark(ctx, px + pad, glyphY, glyph, { ink: '#eef6fb', node: BRAND.cyan, glow: glyph > 18 });

  if (wordmark) {
    ctx.fillStyle = 'rgba(232, 244, 250, 0.88)';
    ctx.fillText(label, px + pad + glyph + gap, py + plateH / 2 + fontSize * 0.06);
  }
  ctx.restore();
}
