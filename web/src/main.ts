/** Wires the DOM to the pipeline: load tiles, grid the target, hand the
 * maths to a worker, then render and animate what comes back. */

import './style.css';
import { animate } from './lib/animate';
import type { AnimationHandle } from './lib/animate';
import { drawContactSheet, drawGridPreview, drawMosaic, tileBitmaps } from './lib/canvas';
import { cellMeans, gridTarget } from './lib/grid';
import { loadAtlas, loadFiles } from './lib/tiles';
import type { FeatureKind, PipelineParams, PipelineResult, TileSet } from './lib/types';

const PRESETS = [
  { id: 'sunset', label: 'Sunset', url: '/demo/demo_sunset.png' },
  { id: 'gradient', label: 'Spectrum', url: '' },
  { id: 'portrait', label: 'Rings', url: '' },
];

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const stageCanvas = $<HTMLCanvasElement>('stage-canvas');
const previewCanvas = $<HTMLCanvasElement>('preview-canvas');
const mosaicCanvas = $<HTMLCanvasElement>('mosaic-canvas');
const overlay = $('stage-overlay');
const statusText = $('stage-status');
const errorBox = $('error');
const runButton = $<HTMLButtonElement>('run');
const replayButton = $<HTMLButtonElement>('replay');
const downloadButton = $<HTMLButtonElement>('download');
const resetLibraryButton = $<HTMLButtonElement>('reset-library');
const libraryLabel = $('library-label');

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

interface State {
  target: ImageBitmap | null;
  targetName: string;
  userFiles: File[] | null;
  tiles: TileSet | null;
  tilesSize: number;
  result: PipelineResult | null;
  animation: AnimationHandle | null;
  busy: boolean;
  feature: FeatureKind;
}

const state: State = {
  target: null,
  targetName: 'sunset',
  userFiles: null,
  tiles: null,
  tilesSize: 0,
  result: null,
  animation: null,
  busy: false,
  feature: 'mean_rgb',
};

/* ---------------------------------------------------------------- inputs */

function readParams(): PipelineParams {
  return {
    tileSize: Number($<HTMLInputElement>('in-tile').value),
    gridCols: Number($<HTMLInputElement>('in-cols').value),
    k: Number($<HTMLInputElement>('in-k').value),
    feature: state.feature,
    variety: Number($<HTMLInputElement>('in-variety').value),
    compare: $<HTMLInputElement>('in-compare').checked,
  };
}

function bindSlider(inputId: string, outputId: string, format: (v: number) => string) {
  const input = $<HTMLInputElement>(inputId);
  const output = $(outputId);
  const sync = () => {
    output.textContent = format(Number(input.value));
  };
  input.addEventListener('input', sync);
  sync();
}

bindSlider('in-k', 'out-k', (v) => String(v));
bindSlider('in-tile', 'out-tile', (v) => `${v} px`);
bindSlider('in-cols', 'out-cols', (v) => `${v} tiles`);
bindSlider('in-variety', 'out-variety', (v) => v.toFixed(2));

$('feature-toggle').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-feature]');
  if (!button) return;
  state.feature = button.dataset.feature as FeatureKind;
  $('feature-toggle')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('active', b === button));
});

/* ------------------------------------------------------- target presets */

/** Two of the presets are drawn on the fly — a spectrum sweep and a set of
 * rings — so there's something to try beyond the bundled photo. */
function generatePreset(id: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  if (id === 'gradient') {
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    for (let i = 0; i <= 6; i++) {
      gradient.addColorStop(i / 6, `hsl(${(i / 6) * 320}, 78%, 56%)`);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#0e1118';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 9; i >= 0; i--) {
      ctx.beginPath();
      ctx.arc(canvas.width / 2, canvas.height / 2, 40 + i * 34, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${190 + i * 16}, ${70 - i * 3}%, ${62 - i * 4}%)`;
      ctx.fill();
    }
  }
  return canvas;
}

async function setTargetFromPreset(id: string) {
  const preset = PRESETS.find((p) => p.id === id)!;
  state.targetName = id;
  document
    .querySelectorAll('#target-presets button')
    .forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.preset === id));

  state.target?.close();
  if (preset.url) {
    const blob = await fetch(preset.url).then((r) => r.blob());
    state.target = await createImageBitmap(blob);
  } else {
    state.target = await createImageBitmap(generatePreset(id));
  }
}

function buildPresetButtons() {
  const row = $('target-presets');
  PRESETS.forEach((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = preset.label;
    button.dataset.preset = preset.id;
    button.className = preset.id === 'sunset' ? 'chip active' : 'chip';
    button.addEventListener('click', async () => {
      if (state.busy) return;
      await setTargetFromPreset(preset.id);
      void run();
    });
    row.appendChild(button);
  });
}

$<HTMLInputElement>('target-file').addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    state.target?.close();
    state.target = await createImageBitmap(file);
    state.targetName = file.name;
    document
      .querySelectorAll('#target-presets button')
      .forEach((b) => b.classList.remove('active'));
    await run();
  } catch {
    showError("That file couldn't be read as an image.");
  }
});

/* ------------------------------------------------------- source library */

$<HTMLInputElement>('source-files').addEventListener('change', async (event) => {
  const files = Array.from((event.target as HTMLInputElement).files ?? []);
  if (!files.length) return;
  state.userFiles = files;
  state.tiles = null;
  state.tilesSize = 0;
  resetLibraryButton.hidden = false;
  await run();
});

resetLibraryButton.addEventListener('click', async () => {
  state.userFiles = null;
  state.tiles = null;
  state.tilesSize = 0;
  resetLibraryButton.hidden = true;
  $<HTMLInputElement>('source-files').value = '';
  await run();
});

/** Tiles are cached per tile size; changing the size forces a reload. */
async function ensureTiles(tileSize: number): Promise<TileSet> {
  if (state.tiles && state.tilesSize === tileSize) return state.tiles;

  const tiles = state.userFiles
    ? await loadFiles(state.userFiles, tileSize, 1200, (done, total) => {
        setStatus(`Reading your photos… ${done}/${total}`);
      })
    : await loadAtlas(tileSize);

  state.tiles = tiles;
  state.tilesSize = tileSize;
  libraryLabel.textContent = state.userFiles
    ? `Your folder — ${tiles.count} tiles`
    : `Bundled demo library — ${tiles.count} tiles`;
  return tiles;
}

/* -------------------------------------------------------------- running */

let requestId = 0;

function runInWorker(
  cells: TileSet,
  means: Uint8Array,
  rows: number,
  cols: number,
  tiles: TileSet,
  params: PipelineParams,
): Promise<PipelineResult> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      if (event.data.ok) resolve(event.data.result as PipelineResult);
      else reject(new Error(event.data.error));
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, cells, cellMeans: means, rows, cols, tiles, params });
  });
}

async function run() {
  if (state.busy || !state.target) return;
  state.busy = true;
  setBusy(true);
  hideError();

  try {
    const params = readParams();
    setStatus('Loading tiles…');
    const tiles = await ensureTiles(params.tileSize);

    setStatus('Gridding the target…');
    const { cells, rows, cols } = gridTarget(state.target, params.tileSize, params.gridCols);
    const means = cellMeans(cells);

    setStatus(`Clustering ${tiles.count} tiles and matching ${cells.count} cells…`);
    const result = await runInWorker(cells, means, rows, cols, tiles, params);
    state.result = result;

    drawGridPreview(previewCanvas, result.cellMeans, rows, cols);
    drawMosaic(mosaicCanvas, result.choice, tiles, rows, cols);
    renderStats(result);
    renderClusters(result, tiles);
    renderBenchmark(result);

    overlay.classList.add('hidden');
    await playAnimation();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    overlay.classList.add('hidden');
  } finally {
    state.busy = false;
    setBusy(false);
  }
}

async function playAnimation() {
  const result = state.result;
  const tiles = state.tiles;
  if (!result || !tiles) return;

  state.animation?.stop();
  const bitmaps = await tileBitmaps(tiles, result.choice);
  state.animation = animate(
    stageCanvas,
    result.choice,
    bitmaps,
    result.stats.rows,
    result.stats.cols,
    tiles.size,
  );
  await state.animation.done;
  // Settle on the crisp static render so the final frame isn't a
  // half-pixel-aligned approximation of it.
  drawMosaic(stageCanvas, result.choice, tiles, result.stats.rows, result.stats.cols);
}

runButton.addEventListener('click', () => void run());
replayButton.addEventListener('click', () => void playAnimation());
downloadButton.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = `mosaic-${state.targetName.replace(/\.[^.]+$/, '')}.png`;
  link.href = mosaicCanvas.toDataURL('image/png');
  link.click();
});

/* ------------------------------------------------------------- rendering */

function renderStats(result: PipelineResult) {
  const s = result.stats;
  const items: [string, string][] = [
    ['grid', `${s.rows} × ${s.cols}`],
    ['cells', s.cells.toLocaleString()],
    ['tiles', s.tiles.toLocaleString()],
    ['clusters', String(s.k)],
    ['feature dims', String(s.featureDims)],
    ['unique tiles used', `${s.uniqueTiles} / ${s.tiles}`],
    ['k-means', `${s.msKmeans.toFixed(0)} ms`],
    ['matching', `${s.msCluster.toFixed(0)} ms`],
  ];
  $('stat-strip').innerHTML = items
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');
}

function renderClusters(result: PipelineResult, tiles: TileSet) {
  const container = $('clusters');
  container.innerHTML = '';
  for (let c = 0; c < result.stats.k; c++) {
    const canvas = document.createElement('canvas');
    const members = drawContactSheet(canvas, tiles, result.labels, c);
    if (!members) continue;
    const figure = document.createElement('figure');
    figure.className = 'cluster';
    canvas.className = 'pixelated';
    const caption = document.createElement('figcaption');
    caption.innerHTML = `cluster ${String(c).padStart(2, '0')} <span>${
      result.stats.clusterSizes[c]
    } tiles</span>`;
    figure.append(canvas, caption);
    container.appendChild(figure);
  }
}

function renderBenchmark(result: PipelineResult) {
  const s = result.stats;
  const saved = s.distBrute > 0 ? 1 - s.distClustered / s.distBrute : 0;
  const rows = [
    ['', 'distance computations', 'wall clock'],
    [
      'brute force',
      s.distBrute.toLocaleString(),
      s.msBrute === null ? '— (skipped)' : `${s.msBrute.toFixed(1)} ms`,
    ],
    [
      'cluster-accelerated',
      s.distClustered.toLocaleString(),
      `${s.msCluster.toFixed(1)} ms`,
    ],
  ];
  const speedup =
    s.msBrute !== null && s.msCluster > 0 ? (s.msBrute / s.msCluster).toFixed(2) : null;

  $('benchmark').innerHTML = `
    <table>
      <thead><tr>${rows[0].map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows
          .slice(1)
          .map((r) => `<tr>${r.map((cell, i) => (i ? `<td>${cell}</td>` : `<th scope="row">${cell}</th>`)).join('')}</tr>`)
          .join('')}
      </tbody>
    </table>
    <p class="benchmark-summary">
      Clustering skipped <strong>${(saved * 100).toFixed(1)}%</strong> of the
      distance work${speedup ? `, for a <strong>${speedup}×</strong> wall-clock difference` : ''}
      at k=${s.k} over ${s.tiles.toLocaleString()} tiles and
      ${s.cells.toLocaleString()} cells.
    </p>`;
}

/* --------------------------------------------------------------- chrome */

function setStatus(message: string) {
  statusText.textContent = message;
  overlay.classList.remove('hidden');
}

function setBusy(busy: boolean) {
  runButton.disabled = busy;
  runButton.textContent = busy ? 'Working…' : 'Generate mosaic';
  replayButton.disabled = busy || !state.result;
  downloadButton.disabled = busy || !state.result;
}

function showError(message: string) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.hidden = true;
}

/* ----------------------------------------------------------------- boot */

async function boot() {
  buildPresetButtons();
  try {
    await setTargetFromPreset('sunset');
    await run();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    overlay.classList.add('hidden');
  }
}

void boot();
