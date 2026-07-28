/** Wires the DOM to the pipeline: load tiles, grid the target, hand the
 * maths to a worker, then render, narrate and animate what comes back.
 *
 * "Narrate" is doing real work here. The mosaic is the output, but the
 * subject is the model that produced it, so every run also emits a trace,
 * four diagnostic plots and a per-cell record of what the matcher decided
 * and why. Nothing on the page is illustrative — if a number is on screen,
 * this run produced it. */

import './style.css';
import { animate } from './lib/animate';
import type { AnimationHandle } from './lib/animate';
import { markSvg } from './lib/brand';
import {
  drawContactSheet,
  drawClusterMap,
  drawGridPreview,
  drawMosaic,
  drawResidual,
  tileBitmaps,
} from './lib/canvas';
import { drawConvergence, drawFeatureSpace, drawKScan, drawRestarts } from './lib/charts';
import { cellMeans, gridTarget } from './lib/grid';
import { attachInspector } from './lib/inspect';
import { startRain } from './lib/matrix';
import { canRecord, saveBlob, startRecording } from './lib/record';
import { loadAtlas, loadFiles } from './lib/tiles';
import type {
  FeatureKind,
  KScanPoint,
  PipelineParams,
  PipelineResult,
  TileSet,
} from './lib/types';

const PRESETS = [
  { id: 'sunset', label: 'Sunset', url: '/demo/demo_sunset.png' },
  { id: 'gradient', label: 'Spectrum', url: '' },
  { id: 'portrait', label: 'Rings', url: '' },
];

const SCAN_FROM = 2;
const SCAN_TO = 16;

type StageView = 'animation' | 'target' | 'means' | 'clusters' | 'mosaic' | 'residual';

const VIEW_CAPTIONS: Record<StageView, string> = {
  animation:
    'Tiles fly in from off the canvas and cool from cyan to their true colour as they land.',
  target: 'The source image, before anything has been done to it.',
  means:
    'Each cell collapsed to one average colour — 3 numbers per cell. This, not the photograph, is what the matcher is chasing.',
  clusters:
    "The target repainted in exactly k colours: every cell filled with the mean colour of the cluster it was routed to. This is the model's own resolution — everything finer has to be recovered by searching inside a cluster.",
  mosaic: 'The finished mosaic at native tile resolution.',
  residual:
    'Where the library ran out: brighter means the closest available tile was still far from the colour asked for. The variety penalty is excluded here, so this is coverage alone — bright regions are fixed by adding photos, not by turning knobs.',
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const stageCanvas = $<HTMLCanvasElement>('stage-canvas');
const previewCanvas = $<HTMLCanvasElement>('preview-canvas');
const mosaicCanvas = $<HTMLCanvasElement>('mosaic-canvas');
const spaceCanvas = $<HTMLCanvasElement>('space-canvas');
const convergeCanvas = $<HTMLCanvasElement>('converge-canvas');
const restartCanvas = $<HTMLCanvasElement>('restart-canvas');
const kscanCanvas = $<HTMLCanvasElement>('kscan-canvas');
const overlay = $('stage-overlay');
const statusText = $('stage-status');
const errorBox = $('error');
const runButton = $<HTMLButtonElement>('run');
const replayButton = $<HTMLButtonElement>('replay');
const downloadButton = $<HTMLButtonElement>('download');
const recordButton = $<HTMLButtonElement>('record');
const scanButton = $<HTMLButtonElement>('scan-k');
const resetLibraryButton = $<HTMLButtonElement>('reset-library');
const libraryLabel = $('library-label');
const stageCaption = $('stage-caption');
const scrub = $('scrub');
const scrubFill = scrub.firstElementChild as HTMLElement;
const recDot = $('rec-dot');

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

interface State {
  target: ImageBitmap | null;
  targetName: string;
  userFiles: File[] | null;
  tiles: TileSet | null;
  tilesSize: number;
  result: PipelineResult | null;
  animation: AnimationHandle | null;
  busy: boolean;
  recording: boolean;
  feature: FeatureKind;
  view: StageView;
  highlight: number | null;
  scan: KScanPoint[] | null;
  scanKey: string;
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
  recording: false,
  feature: 'mean_rgb',
  view: 'animation',
  highlight: null,
  scan: null,
  scanKey: '',
};

/* ----------------------------------------------------------------- chrome */

$('brand-mark').innerHTML = markSvg(30);
$('footer-mark').innerHTML = markSvg(18);
startRain($<HTMLCanvasElement>('rain'));

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

/* --------------------------------------------------------- target presets */

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

/* --------------------------------------------------------- source library */

$<HTMLInputElement>('source-files').addEventListener('change', async (event) => {
  const files = Array.from((event.target as HTMLInputElement).files ?? []);
  if (!files.length) return;
  state.userFiles = files;
  state.tiles = null;
  state.tilesSize = 0;
  state.scan = null;
  resetLibraryButton.hidden = false;
  await run();
});

resetLibraryButton.addEventListener('click', async () => {
  state.userFiles = null;
  state.tiles = null;
  state.tilesSize = 0;
  state.scan = null;
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
  state.scan = null;
  libraryLabel.textContent = state.userFiles
    ? `Your folder — ${tiles.count} tiles`
    : `Bundled demo library — ${tiles.count} tiles`;
  return tiles;
}

/* -------------------------------------------------------------- the worker */

let requestId = 0;

function ask<T>(message: Record<string, unknown>, key: 'result' | 'scan'): Promise<T> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      if (event.data.ok) resolve(event.data[key] as T);
      else reject(new Error(event.data.error));
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ ...message, id });
  });
}

/* ------------------------------------------------------------------ running */

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

    setStatus(`Fitting k-means on ${tiles.count} tiles, matching ${cells.count} cells…`);
    const result = await ask<PipelineResult>(
      { kind: 'run', cells, cellMeans: means, rows, cols, tiles, params },
      'result',
    );
    state.result = result;
    state.highlight = null;

    drawGridPreview(previewCanvas, result.cellMeans, rows, cols);
    drawMosaic(mosaicCanvas, result.choice, tiles, rows, cols);
    renderStats(result);
    renderConsole(result, params);
    renderClusters(result, tiles);
    renderBenchmark(result);
    renderInsights(result);

    overlay.classList.add('hidden');
    await showView(state.view, true);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    overlay.classList.add('hidden');
  } finally {
    state.busy = false;
    setBusy(false);
  }
}

runButton.addEventListener('click', () => void run());

/* -------------------------------------------------------------- stage views */

function fitStage(width: number, height: number): CanvasRenderingContext2D {
  stageCanvas.width = width;
  stageCanvas.height = height;
  const ctx = stageCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Blit a small canvas (a per-cell map, one pixel per cell) up to the full
 * mosaic resolution, so every stage view shares one frame size. */
function blitUpscaled(source: HTMLCanvasElement, tileSize: number) {
  const ctx = fitStage(source.width * tileSize, source.height * tileSize);
  ctx.drawImage(source, 0, 0, stageCanvas.width, stageCanvas.height);
}

async function showView(view: StageView, forceReplay = false) {
  state.view = view;
  document
    .querySelectorAll('#view-switch button')
    .forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.view === view));
  stageCaption.textContent = VIEW_CAPTIONS[view];

  const result = state.result;
  const tiles = state.tiles;
  if (!result || !tiles) return;
  const { rows, cols } = result.stats;
  const t = tiles.size;

  if (view !== 'animation') {
    state.animation?.stop();
    scrub.classList.remove('on');
  }

  const scratch = document.createElement('canvas');
  switch (view) {
    case 'animation':
      if (forceReplay) await playAnimation();
      else drawMosaic(stageCanvas, result.choice, tiles, rows, cols);
      break;
    case 'target': {
      const ctx = fitStage(cols * t, rows * t);
      ctx.imageSmoothingEnabled = true;
      if (state.target) ctx.drawImage(state.target, 0, 0, stageCanvas.width, stageCanvas.height);
      break;
    }
    case 'means':
      drawGridPreview(scratch, result.cellMeans, rows, cols);
      blitUpscaled(scratch, t);
      break;
    case 'clusters':
      drawClusterMap(scratch, result.cellCluster, result.clusterColors, rows, cols);
      blitUpscaled(scratch, t);
      break;
    case 'residual':
      drawResidual(scratch, result.cellNearest, rows, cols);
      blitUpscaled(scratch, t);
      break;
    case 'mosaic':
      drawMosaic(stageCanvas, result.choice, tiles, rows, cols);
      break;
  }
}

$('view-switch').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
  if (!button || state.busy || state.recording) return;
  void showView(button.dataset.view as StageView, button.dataset.view === 'animation');
});

/* -------------------------------------------------------------- animation */

async function playAnimation(onFrame?: () => void, hold = 0) {
  const result = state.result;
  const tiles = state.tiles;
  if (!result || !tiles) return;

  state.animation?.stop();
  const bitmaps = await tileBitmaps(tiles, result.choice);
  scrub.classList.add('on');
  scrubFill.style.width = '0%';

  state.animation = animate(
    stageCanvas,
    result.choice,
    bitmaps,
    result.stats.rows,
    result.stats.cols,
    tiles.size,
    {
      hold,
      onFrame,
      still: reducedMotion.matches,
      onProgress: (fraction) => {
        scrubFill.style.width = `${(fraction * 100).toFixed(1)}%`;
      },
    },
  );
  await state.animation.done;
  scrub.classList.remove('on');
}

replayButton.addEventListener('click', () => void showView('animation', true));

downloadButton.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = `mosaic-${state.targetName.replace(/\.[^.]+$/, '')}.png`;
  link.href = mosaicCanvas.toDataURL('image/png');
  link.click();
});

/* --------------------------------------------------------------- recording */

if (!canRecord()) {
  recordButton.hidden = true;
  $('record-note').textContent =
    'Video export needs MediaRecorder, which this browser does not provide — Save PNG still works, and the Python CLI can record the same animation with --record.';
}

recordButton.addEventListener('click', async () => {
  if (state.recording || !state.result) return;
  const recorder = startRecording(stageCanvas);
  if (!recorder) {
    showError('This browser refused to start a recording.');
    return;
  }

  state.recording = true;
  recDot.hidden = false;
  recordButton.textContent = 'Recording…';
  setBusy(true);
  await showView('animation');

  try {
    // A second of stillness on the finished mosaic, so the clip resolves
    // instead of stopping dead on the last tile.
    await playAnimation(() => recorder.frame(), 1.2);
    const { blob, extension } = await recorder.stop();
    saveBlob(blob, `preciado-mosaic-${state.targetName.replace(/\.[^.]+$/, '')}.${extension}`);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    state.recording = false;
    recDot.hidden = true;
    recordButton.textContent = 'Save video';
    setBusy(false);
  }
});

/* ------------------------------------------------------------- the k sweep */

scanButton.addEventListener('click', async () => {
  const tiles = state.tiles;
  if (!tiles || state.busy) return;
  scanButton.disabled = true;
  scanButton.textContent = `Fitting ${SCAN_TO - SCAN_FROM + 1} models…`;
  $('kscan-note').textContent = '';

  try {
    const scan = await ask<KScanPoint[]>(
      { kind: 'scan', tiles, feature: state.feature, from: SCAN_FROM, to: SCAN_TO },
      'scan',
    );
    state.scan = scan;
    state.scanKey = `${tiles.count}·${state.feature}`;
    renderKScan();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    scanButton.disabled = false;
    scanButton.textContent = `Run the sweep — k = ${SCAN_FROM}…${SCAN_TO}`;
  }
});

function renderKScan() {
  const scan = state.scan;
  const note = $('kscan-note');
  if (!scan?.length) {
    drawKScan(kscanCanvas, [], 0);
    return;
  }
  const currentK = state.result?.stats.k ?? 0;
  drawKScan(kscanCanvas, scan, currentK);

  const best = scan.reduce((a, b) => (b.silhouette > a.silhouette ? b : a));
  const stale = state.scanKey !== `${state.tiles?.count}·${state.feature}`;
  note.innerHTML = stale
    ? 'The library or feature changed — run the sweep again.'
    : `Silhouette peaks at <b>k = ${best.k}</b> (${best.silhouette.toFixed(3)}). ` +
      `Inertia fell ${(
        (1 - scan[scan.length - 1].inertia / scan[0].inertia) *
        100
      ).toFixed(0)}% across the sweep and never rose — which is why it can't choose for you.`;
}

/* -------------------------------------------------------------- rendering */

function renderStats(result: PipelineResult) {
  const s = result.stats;
  const items: [string, string][] = [
    ['grid', `${s.rows} × ${s.cols}`],
    ['cells', s.cells.toLocaleString()],
    ['tiles', s.tiles.toLocaleString()],
    ['clusters', String(s.k)],
    ['feature dims', String(s.featureDims)],
    ['distinct tiles', `${s.uniqueTiles} / ${s.tiles}`],
    ['k-means', `${s.msKmeans.toFixed(0)} ms`],
    ['matching', `${s.msCluster.toFixed(0)} ms`],
  ];
  $('stat-strip').innerHTML = items
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');
}

/* The run log ---------------------------------------------------------- */

interface LogRow {
  stage: string;
  detail: string;
  sub?: boolean;
}

function renderConsole(result: PipelineResult, params: PipelineParams) {
  const s = result.stats;
  const rows: LogRow[] = [];
  const push = (stage: string, detail: string, sub = false) => rows.push({ stage, detail, sub });

  push(
    'grid',
    `${s.cols} × ${s.rows} cells at <b>${params.tileSize} px</b> → <b>${s.cells.toLocaleString()}</b> cells`,
  );
  push('library', `<b>${s.tiles.toLocaleString()}</b> tiles, centre-cropped square, no labels attached`);
  push(
    'features',
    `<b>${params.feature}</b> · ${(s.cells + s.tiles).toLocaleString()} vectors in ℝ<sup>${s.featureDims}</sup> · ${s.msFeatures.toFixed(1)} ms`,
  );
  push(
    'k-means',
    `k = <b>${s.k}</b> · k-means++ seeding · ${s.restarts.length} restarts · ${s.msKmeans.toFixed(1)} ms`,
  );

  // The convergence trace, thinned in the middle if it ran long — the first
  // and last few iterations are where anything happens.
  const trace = s.trace;
  const shown =
    trace.length <= 7 ? trace.map((t, i) => [t, i] as const) : [
      ...trace.slice(0, 3).map((t, i) => [t, i] as const),
      ...trace.slice(-3).map((t, i) => [t, trace.length - 3 + i] as const),
    ];
  let elided = false;
  shown.forEach(([step, index]) => {
    if (trace.length > 7 && index === trace.length - 3 && !elided) {
      elided = true;
      push('', `… ${trace.length - 6} more iterations`, true);
    }
    push(
      `iter ${String(step.iter).padStart(2, ' ')}`,
      step.moved === 0
        ? `inertia ${fmt(step.inertia)} · <b>0 moved — converged</b>`
        : `inertia ${fmt(step.inertia)} · ${step.moved.toLocaleString()} tile${
            step.moved === 1 ? '' : 's'
          } moved · centres travelled ${step.shift.toFixed(1)}`,
      true,
    );
  });

  const spread = Math.max(...s.restarts) / Math.max(1e-9, Math.min(...s.restarts)) - 1;
  push(
    'restarts',
    spread < 0.001
      ? `all ${s.restarts.length} restarts landed on the same optimum — the structure here is unambiguous`
      : `best of ${s.restarts.length} · worst restart was <b>${(spread * 100).toFixed(1)}%</b> higher inertia`,
  );
  push(
    'quality',
    `silhouette <b>${s.silhouette.toFixed(3)}</b> over ${s.silhouetteSampled.toLocaleString()} sampled tiles${
      s.silhouette < 0.25 ? ' — weak separation, k is acting as search granularity here' : ''
    }`,
  );
  push(
    'routing',
    `each cell → nearest of ${s.k} centroids, then searched only that cluster (avg <b>${Math.round(
      s.distClustered / Math.max(1, s.cells) - s.k,
    ).toLocaleString()}</b> tiles)`,
  );
  push(
    'matching',
    `<b>${s.distClustered.toLocaleString()}</b> distances vs ${s.distBrute.toLocaleString()} brute force · ${(
      (1 - s.distClustered / Math.max(1, s.distBrute)) *
      100
    ).toFixed(1)}% skipped · ${s.msCluster.toFixed(1)} ms`,
  );
  push(
    'variety',
    params.variety === 0
      ? 'off — every cell got its nearest tile, repeats and all'
      : `penalty <b>${s.penalty.toFixed(2)}</b> per prior use · pushed <b>${s.displaced.toLocaleString()}</b> cells (${(
          (s.displaced / Math.max(1, s.cells)) *
          100
        ).toFixed(0)}%) off their nearest tile`,
  );
  push(
    'result',
    `<b>${s.uniqueTiles.toLocaleString()}</b> distinct tiles used · mean distance ${s.meanDist.toFixed(1)} (best possible ${s.meanNearest.toFixed(1)})`,
  );

  $('console').innerHTML = rows
    .map(
      (row) =>
        `<div class="row${row.sub ? ' sub' : ''}"><span class="glyph">${
          row.sub ? '·' : '▸'
        }</span><span class="stage-name">${row.stage}</span><span>${row.detail}</span></div>`,
    )
    .join('');
}

function fmt(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(1);
}

/* The diagnostic panels ------------------------------------------------ */

function renderInsights(result: PipelineResult) {
  const s = result.stats;

  drawFeatureSpace(spaceCanvas, result.scatter, result.labels, result.tileColors, s.k, {
    highlight: state.highlight,
  });
  const captured = ((result.scatter.explained[0] + result.scatter.explained[1]) * 100).toFixed(1);
  $('space-note').innerHTML =
    `${s.featureDims} dimensions flattened to 2. These axes carry <b>${captured}%</b> of the total variance` +
    (s.featureDims <= 3
      ? ' — at 3 dims almost nothing is being hidden from you.'
      : ' — the rest is off-screen, so read overlap here as "possibly separated", never as "identical".') +
    (result.scatter.cellStride > 1
      ? ` Cells are thinned to 1 in ${result.scatter.cellStride} for legibility.`
      : ' Every cell is plotted.');

  drawConvergence(convergeCanvas, s.trace);
  const iterations = s.trace.length;
  const drop = s.trace.length > 1 ? 1 - s.trace[iterations - 1].inertia / s.trace[0].inertia : 0;
  $('converge-note').innerHTML =
    `Converged in <b>${iterations}</b> iteration${iterations === 1 ? '' : 's'}, ` +
    `inertia down <b>${(drop * 100).toFixed(1)}%</b> from the seeded assignment. ` +
    `Final inertia ${fmt(s.inertia)}.`;

  drawRestarts(restartCanvas, s.restarts);
  const worst = Math.max(...s.restarts);
  const best = Math.min(...s.restarts);
  $('restart-note').innerHTML =
    worst / best - 1 < 0.001
      ? 'Every restart converged to the same inertia. When the data has one obvious partition, seeding stops mattering — and that itself is worth knowing.'
      : `Worst restart was <b>${(((worst - best) / best) * 100).toFixed(1)}%</b> off the best. That gap is the cost of trusting a single run.`;

  renderKScan();
  renderVarietyLedger(result);
}

function renderVarietyLedger(result: PipelineResult) {
  const s = result.stats;
  const cost = s.meanDist - s.meanNearest;
  const rows: [string, string, boolean?][] = [
    ['cells placed', s.cells.toLocaleString()],
    ['distinct tiles used', `${s.uniqueTiles.toLocaleString()} / ${s.tiles.toLocaleString()}`, true],
    ['library covered', `${((s.uniqueTiles / Math.max(1, s.tiles)) * 100).toFixed(0)}%`],
    ['', ''],
    ['penalty per reuse', s.penalty.toFixed(2)],
    ['cells pushed off nearest', `${s.displaced.toLocaleString()} (${((s.displaced / Math.max(1, s.cells)) * 100).toFixed(0)}%)`],
    ['', ''],
    ['mean distance, unpenalised', s.meanNearest.toFixed(2)],
    ['mean distance, as placed', s.meanDist.toFixed(2)],
    ['fidelity given up', `+${cost.toFixed(2)}`, true],
  ];

  $('variety-ledger').innerHTML = rows
    .map(([label, value, accent]) =>
      label === ''
        ? '<div class="rule"></div>'
        : `<dt>${label}</dt><dd${accent ? ' class="accent"' : ''}>${value}</dd>`,
    )
    .join('');

  $('variety-note').innerHTML =
    cost < 0.005
      ? 'Variety is off or costing nothing: no cell was pushed off its first choice.'
      : `Each cell is on average <b>${cost.toFixed(2)}</b> further from its ideal tile than it had to be — ` +
        `${((cost / Math.max(1e-9, s.meanNearest)) * 100).toFixed(0)}% worse — bought with ` +
        `<b>${s.uniqueTiles.toLocaleString()}</b> distinct photos on screen instead of a handful repeated. ` +
        'There is no setting that gives you both.';
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

    // Hovering a contact sheet isolates that cluster in the feature-space
    // plot — the link between "these photos" and "this region of ℝⁿ".
    figure.addEventListener('pointerenter', () => setHighlight(c));
    figure.addEventListener('pointerleave', () => setHighlight(null));
    container.appendChild(figure);
  }
}

function setHighlight(cluster: number | null) {
  if (state.highlight === cluster || !state.result) return;
  state.highlight = cluster;
  drawFeatureSpace(
    spaceCanvas,
    state.result.scatter,
    state.result.labels,
    state.result.tileColors,
    state.result.stats.k,
    { highlight: cluster },
  );
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
    ['cluster-accelerated', s.distClustered.toLocaleString(), `${s.msCluster.toFixed(1)} ms`],
  ];
  const speedup =
    s.msBrute !== null && s.msCluster > 0 ? (s.msBrute / s.msCluster).toFixed(2) : null;

  $('benchmark').innerHTML = `
    <table>
      <thead><tr>${rows[0].map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows
          .slice(1)
          .map(
            (r) =>
              `<tr>${r
                .map((cell, i) => (i ? `<td>${cell}</td>` : `<th scope="row">${cell}</th>`))
                .join('')}</tr>`,
          )
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

/* ----------------------------------------------------------------- chrome */

function setStatus(message: string) {
  statusText.textContent = message;
  overlay.classList.remove('hidden');
}

function setBusy(busy: boolean) {
  const blocked = busy || state.recording;
  runButton.disabled = blocked;
  runButton.textContent = busy && !state.recording ? 'Working…' : 'Generate mosaic';
  replayButton.disabled = blocked || !state.result;
  downloadButton.disabled = blocked || !state.result;
  recordButton.disabled = blocked || !state.result;
  scanButton.disabled = blocked || !state.tiles;
}

function showError(message: string) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.hidden = true;
}

/* Charts are sized from their CSS box, so a resize means a redraw. */
let resizeTimer = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (state.result) renderInsights(state.result);
  }, 180);
});

attachInspector(mosaicCanvas, $('inspector'), () => {
  const result = state.result;
  const tiles = state.tiles;
  if (!result || !tiles) return null;
  return {
    rows: result.stats.rows,
    cols: result.stats.cols,
    cellMeans: result.cellMeans,
    choice: result.choice,
    cellCluster: result.cellCluster,
    cellDist: result.cellDist,
    cellNearest: result.cellNearest,
    cellCandidates: result.cellCandidates,
    tiles,
    tileColors: result.tileColors,
    tilesTotal: result.stats.tiles,
    featureName: state.feature === 'histogram' ? 'histogram' : 'mean RGB',
  };
});

/* -------------------------------------------------------------------- boot */

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
