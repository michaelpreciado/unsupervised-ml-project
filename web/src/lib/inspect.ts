/** Hover readout for the finished mosaic.
 *
 * A photo mosaic is a grid of a few thousand independent decisions, and the
 * finished image is exactly the view that hides them. This turns any cell
 * back into the decision that produced it: what colour was asked for, which
 * cluster the request was routed to, how many tiles that left to search,
 * what came back and how far off it was. */

import type { TileSet } from './types';

export interface InspectData {
  rows: number;
  cols: number;
  cellMeans: Uint8Array;
  choice: Int32Array;
  cellCluster: Int32Array;
  cellDist: Float32Array;
  cellNearest: Float32Array;
  cellCandidates: Int32Array;
  tiles: TileSet;
  tileColors: Uint8Array;
  tilesTotal: number;
  featureName: string;
}

function swatchCanvas(tiles: TileSet, index: number): HTMLCanvasElement {
  const t = tiles.size;
  const canvas = document.createElement('canvas');
  canvas.width = t;
  canvas.height = t;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(t, t);
  const base = index * t * t * 3;
  for (let p = 0; p < t * t; p++) {
    image.data[p * 4] = tiles.data[base + p * 3];
    image.data[p * 4 + 1] = tiles.data[base + p * 3 + 1];
    image.data[p * 4 + 2] = tiles.data[base + p * 3 + 2];
    image.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function attachInspector(
  canvas: HTMLCanvasElement,
  tooltip: HTMLElement,
  getData: () => InspectData | null,
): void {
  let lastCell = -1;

  function hide() {
    tooltip.hidden = true;
    lastCell = -1;
  }

  canvas.addEventListener('pointerleave', hide);

  canvas.addEventListener('pointermove', (event) => {
    const data = getData();
    if (!data) return hide();

    // The canvas is laid out by CSS at some other size than its backing
    // store, so pointer position has to be renormalised before it means
    // anything in grid coordinates.
    const rect = canvas.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return hide();

    const c = Math.min(data.cols - 1, Math.floor(fx * data.cols));
    const r = Math.min(data.rows - 1, Math.floor(fy * data.rows));
    const i = r * data.cols + c;

    // Reposition every move, but only rebuild the contents when the pointer
    // actually crosses into a new cell.
    const offset = 16;
    const wantsLeft = fx > 0.55;
    tooltip.style.left = wantsLeft ? 'auto' : `${event.clientX - rect.left + offset}px`;
    tooltip.style.right = wantsLeft ? `${rect.width - (event.clientX - rect.left) + offset}px` : 'auto';
    tooltip.style.top = `${Math.max(0, event.clientY - rect.top - 30)}px`;
    tooltip.hidden = false;
    if (i === lastCell) return;
    lastCell = i;

    const tile = data.choice[i];
    const cluster = data.cellCluster[i];
    const asked = `rgb(${data.cellMeans[i * 3]}, ${data.cellMeans[i * 3 + 1]}, ${data.cellMeans[i * 3 + 2]})`;
    const searched = data.cellCandidates[i];
    const skipped = 1 - searched / Math.max(1, data.tilesTotal);
    const got = data.cellDist[i];
    const best = data.cellNearest[i];
    // Only worth a line when the two differ: that difference is the variety
    // penalty, made specific to one cell.
    const taxed = got > best + 1e-6;

    tooltip.innerHTML = `
      <div class="swatches">
        <span class="sw" style="background:${asked}"></span>
        <span class="arrow">→</span>
        <span class="sw" data-slot="tile"></span>
      </div>
      <div><span class="k">cell</span><span class="v">r${r} · c${c}</span></div>
      <div><span class="k">routed to</span><span class="v">cluster ${String(Math.max(0, cluster)).padStart(2, '0')}</span></div>
      <div><span class="k">searched</span><span class="v">${searched} of ${data.tilesTotal.toLocaleString()}</span></div>
      <div><span class="k">skipped</span><span class="v">${(skipped * 100).toFixed(0)}%</span></div>
      <div><span class="k">tile</span><span class="v">#${tile}</span></div>
      <div><span class="k">${data.featureName} distance</span><span class="v">${got.toFixed(1)}</span></div>
      ${
        taxed
          ? `<div><span class="k">best available</span><span class="v">${best.toFixed(1)} — taken</span></div>`
          : ''
      }`;

    tooltip.querySelector('[data-slot="tile"]')?.appendChild(swatchCanvas(data.tiles, tile));
  });
}
