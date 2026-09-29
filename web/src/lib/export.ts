/** High-resolution export.
 *
 * The on-screen mosaic is built from working tiles (8-32 px) because that is
 * what the model sees. The library was decoded at a higher resolution too,
 * so a print-size export re-composites the same layout from those sheets:
 * identical decisions, several times the detail. */

import type { Lod } from './tiles';

export interface ExportPlan {
  tilePx: number;
  width: number;
  height: number;
  /** false when the LOD sheet can't beat the native render. */
  hires: boolean;
}

/** Browsers cap canvas edges (~16k) and area (~268M px on desktop Chrome, far
 * less on phones), so the tile size is whatever the grid allows. */
const MAX_EDGE = 16384;
const MAX_AREA = 64_000_000;

export function planExport(rows: number, cols: number, nativeTile: number, lod: Lod | null): ExportPlan {
  const native: ExportPlan = { tilePx: nativeTile, width: cols * nativeTile, height: rows * nativeTile, hires: false };
  if (!lod) return native;
  const tilePx = Math.min(
    lod.size,
    Math.floor(MAX_EDGE / Math.max(rows, cols)),
    Math.floor(Math.sqrt(MAX_AREA / (rows * cols))),
  );
  if (tilePx <= nativeTile) return native;
  return { tilePx, width: cols * tilePx, height: rows * tilePx, hires: true };
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode that image — try a smaller mosaic.'))), 'image/png'),
  );
}

export async function exportHiRes(
  choice: Int32Array,
  rows: number,
  cols: number,
  plan: ExportPlan,
  lod: Lod,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not allocate a canvas that large.');
  ctx.imageSmoothingQuality = 'high';
  const t = plan.tilePx;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = choice[r * cols + c];
      ctx.drawImage(
        lod.source,
        (idx % lod.cols) * lod.size,
        Math.floor(idx / lod.cols) * lod.size,
        lod.size,
        lod.size,
        c * t,
        r * t,
        t,
        t,
      );
    }
    // Yield every few rows so the progress bar paints and the tab stays live.
    if (r % 4 === 3) {
      onProgress?.((r + 1) / rows);
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  onProgress?.(1);
  return toBlob(canvas);
}

export async function exportNative(canvas: HTMLCanvasElement): Promise<Blob> {
  return toBlob(canvas);
}
