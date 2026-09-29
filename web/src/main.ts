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
import { drawMark, markSvg } from './lib/brand';
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
import { createViewer } from './lib/viewer';
import type { Viewer } from './lib/viewer';
import { createReplay } from './lib/replay';
import type { Replay, ReplayState } from './lib/replay';
import { RECIPES, decodePreset, encodePreset } from './lib/presets';
import type { Preset } from './lib/presets';
import { exportHiRes, exportNative, planExport } from './lib/export';
import type { ExportPlan } from './lib/export';
import { startRain } from './lib/matrix';
import { canRecord, saveBlob, startRecording } from './lib/record';
import { loadAtlas, loadDataUrls, loadFiles } from './lib/tiles';
import type { Library, Lod } from './lib/tiles';
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
  { id: 'preciado', label: 'Preciado Tech', url: '' },
];

const SCAN_FROM = 2;
const SCAN_TO = 16;

type StageView = 'animation' | 'target' | 'means' | 'clusters' | 'mosaic' | 'compare' | 'residual';
const VIEWS: StageView[] = ['animation', 'target', 'means', 'clusters', 'mosaic', 'compare', 'residual'];

const VIEW_CAPTIONS: Record<StageView, string> = {
  animation:
    'Tiles fly in from off the canvas and cool from cyan to their true colour as they land.',
  target: 'The source image, before anything has been done to it.',
  means:
    'Each cell collapsed to one average colour — 3 numbers per cell. This, not the photograph, is what the matcher is chasing.',
  clusters:
    "The target repainted in exactly k colours: every cell filled with the mean colour of the cluster it was routed to. This is the model's own resolution — everything finer has to be recovered by searching inside a cluster.",
  mosaic:
    'Drag to pan, scroll or pinch to zoom, double-click to dive. Zoom past the working tiles and each cell resolves into the full-detail photo the model chose for it.',
  compare:
    'Drag the divider — or focus it and use the arrow keys. Left of the line is the photograph you gave it; right of the line is what the model built from other photos.',
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
/** Untouched native mosaic. mosaicCanvas gets overlays (isolation, cursor), so
 * everything that needs the pure picture reads this one instead. */
const cleanMosaic = document.createElement('canvas');
const spaceCanvas = $<HTMLCanvasElement>('space-canvas');
const convergeCanvas = $<HTMLCanvasElement>('converge-canvas');
const restartCanvas = $<HTMLCanvasElement>('restart-canvas');
const kscanCanvas = $<HTMLCanvasElement>('kscan-canvas');
const overlay = $('stage-overlay');
const statusText = $('stage-status');
const progressBar = $('stage-progress');
const progressFill = progressBar.firstElementChild as HTMLElement;
const cancelButton = $<HTMLButtonElement>('stage-cancel');
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
const zoomCanvas = $<HTMLCanvasElement>('zoom-canvas');
const viewerHud = $('viewer-hud');
const viewerTools = $('viewer-tools');
const compareHandle = $('compare-handle');
const compareLeft = $('compare-left');
const compareRight = $('compare-right');
const stageFrame = $('stage-panel');
const exportSelect = $<HTMLSelectElement>('export-size');
const exportNote = $('export-note');
const shareButton = $<HTMLButtonElement>('share');
const clusterDetail = $('cluster-detail');
const cellReadout = $('cell-readout');
const replayCanvas = $<HTMLCanvasElement>('replay-canvas');
const replayPlay = $<HTMLButtonElement>('replay-play');
const replayScrub = $<HTMLInputElement>('replay-scrub');
const replayReadout = $('replay-readout');

let worker = spawnWorker();

function spawnWorker(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  // A worker that dies (out of memory on a huge library, a bug) must reject
  // the pending request rather than leave the overlay spinning forever.
  w.addEventListener('error', (event) => failPending(event.message || 'The worker crashed.'));
  return w;
}
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

interface State {
  target: ImageBitmap | null;
  targetName: string;
  userFiles: File[] | null;
  googleUrls: string[] | null;
  tiles: TileSet | null;
  lod: Lod | null;
  skipped: number;
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
  selected: number | null;
  hover: number | null;
  comparePos: number;
  cursor: { row: number; col: number } | null;
  exportPlan: ExportPlan | null;
  viewerFor: PipelineResult | null;
}

const state: State = {
  target: null,
  targetName: 'sunset',
  userFiles: null,
  googleUrls: null,
  tiles: null,
  lod: null,
  skipped: 0,
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
  selected: null,
  hover: null,
  comparePos: 0.5,
  cursor: null,
  exportPlan: null,
  viewerFor: null,
};

/* ----------------------------------------------------------------- chrome */

$('brand-mark').innerHTML = markSvg(30);
$('footer-mark').innerHTML = markSvg(18);
startRain($<HTMLCanvasElement>('rain'));
initSurfaceFx();

/** Glass sheen, scroll reveals and tile tilt. All pointer work is
 * delegated from one listener and coalesced into a rAF write. */
function initSurfaceFx() {
  if (reducedMotion.matches) return;
  let pending: PointerEvent | null = null;
  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return;
      if (!pending) requestAnimationFrame(flush);
      pending = e;
    },
    { passive: true },
  );
  function flush() {
    const e = pending;
    pending = null;
    if (!e || !(e.target instanceof Element)) return;
    const panel = e.target.closest<HTMLElement>('.panel');
    if (panel) {
      const r = panel.getBoundingClientRect();
      panel.style.setProperty('--mx', `${e.clientX - r.left}px`);
      panel.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
    const cluster = e.target.closest<HTMLElement>('.cluster');
    if (cluster) {
      const r = cluster.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      cluster.style.setProperty('--ry', `${(nx * 10).toFixed(2)}deg`);
      cluster.style.setProperty('--rx', `${(-ny * 10).toFixed(2)}deg`);
    }
  }
  document.addEventListener(
    'pointerout',
    (e) => {
      const c = (e.target as Element | null)?.closest?.<HTMLElement>('.cluster');
      if (c && !c.contains(e.relatedTarget as Node | null)) {
        c.style.removeProperty('--rx');
        c.style.removeProperty('--ry');
      }
    },
    { passive: true },
  );

  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.04 },
  );
  document
    .querySelectorAll<HTMLElement>('main > section:not(#studio)')
    .forEach((el) => {
      // Sections already on screen must not flash to hidden and back.
      if (el.getBoundingClientRect().top < window.innerHeight) return;
      el.classList.add('reveal-ready');
      io.observe(el);
    });
}

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
  } else if (id === 'preciado') {
    // The brand mark centred on a dark plate — a museum-piece target that
    // shows the whole demo rebuilding the Preciado Tech identity.
    ctx.fillStyle = '#0a0f14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const size = Math.round(canvas.width * 0.62);
    const x = (canvas.width - size) / 2;
    const y = (canvas.height - size) / 2;
    ctx.beginPath();
    ctx.roundRect(x - size * 0.14, y - size * 0.14, size * 1.28, size * 1.28, size * 0.08);
    ctx.fillStyle = 'rgba(28, 46, 60, 0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(92, 225, 242, 0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    drawMark(ctx, x, y, size, { ink: '#f2f6fa', node: '#5ce1f2', glow: true });
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
  state.googleUrls = null;
  state.tiles = null;
  state.tilesSize = 0;
  state.scan = null;
  resetLibraryButton.hidden = false;
  await run();
});

/** Clear whatever source was active so ensureTiles falls back to the atlas. */
function clearUserSource() {
  state.userFiles = null;
  state.googleUrls = null;
  state.tiles = null;
  state.tilesSize = 0;
  state.scan = null;
  $<HTMLInputElement>('source-files').value = '';
}

resetLibraryButton.addEventListener('click', async () => {
  clearUserSource();
  resetLibraryButton.hidden = true;
  await run();
});

const googleButton = $<HTMLButtonElement>('source-google');
const googleQuery = $<HTMLInputElement>('source-query');

async function pullFromGoogle() {
  const query = googleQuery.value.trim();
  if (!query || state.busy) return;
  googleButton.disabled = true;
  googleButton.textContent = 'Pulling…';
  setBusy(true);
  hideError();
  try {
    setStatus(`Asking Google for "${query}"…`);
    const res = await fetch(`/api/images?q=${encodeURIComponent(query)}&n=120`);
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      const msg = data.setup
        ? 'Google tile search is not configured on this deployment yet — using the bundled demo library. (Set GOOGLE_CSE_KEY + GOOGLE_CSE_CX server-side to enable it.)'
        : (data.error ?? 'Could not pull images from Google.');
      showError(msg);
      // Graceful fallback: keep the current library / atlas rather than fail.
      googleButton.disabled = false;
      googleButton.textContent = 'Pull from Google';
      setBusy(false);
      return;
    }

    const tileSize = Number($<HTMLInputElement>('in-tile').value);
    const lib = await loadDataUrls(data.tiles, tileSize, (done, total) =>
      setStatus(`Decoding ${done}/${total} images…`, done / total),
    );
    const tiles = lib.tiles;
    setLibrary(lib);

    // Store the raw list so re-tiling at any size stays cheap; the TileSet
    // below is the at-current-size decode we already have.
    state.googleUrls = data.tiles;
    state.userFiles = null;
    state.tilesSize = tileSize;
    state.scan = null;
    resetLibraryButton.hidden = false;
    libraryLabel.textContent = `Google · "${query}" — ${tiles.count} tiles`;

    await run();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    googleButton.disabled = false;
    googleButton.textContent = 'Pull from Google';
    setBusy(false);
  }
}

googleButton.addEventListener('click', () => void pullFromGoogle());
googleQuery.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void pullFromGoogle();
});

function setLibrary(lib: Library) {
  if (state.lod && state.lod.source !== lib.lod?.source && 'close' in state.lod.source) {
    (state.lod.source as ImageBitmap).close();
  }
  state.tiles = lib.tiles;
  state.lod = lib.lod;
}

/** Tiles are cached per tile size; changing the size forces a reload. */
async function ensureTiles(tileSize: number): Promise<TileSet> {
  if (state.tiles && state.tilesSize === tileSize) return state.tiles;

  let lib: Library & { skipped?: number };
  if (state.userFiles) {
    lib = await loadFiles(state.userFiles, tileSize, 1200, (done, total) =>
      setStatus(`Reading your photos… ${done}/${total}`, done / total),
    );
  } else if (state.googleUrls) {
    lib = await loadDataUrls(state.googleUrls, tileSize, (done, total) =>
      setStatus(`Mapping Google tiles… ${done}/${total}`, done / total),
    );
  } else {
    lib = await loadAtlas(tileSize);
  }
  const tiles = lib.tiles;
  setLibrary(lib);
  state.skipped = lib.skipped ?? 0;
  state.tilesSize = tileSize;
  state.scan = null;
  libraryLabel.textContent = state.userFiles
    ? `Your folder — ${tiles.count} tiles${state.skipped ? ` (${state.skipped} unreadable, skipped)` : ''}`
    : state.googleUrls
      ? `Google library — ${tiles.count} tiles`
      : `Bundled demo library — ${tiles.count} tiles`;
  return tiles;
}

/* -------------------------------------------------------------- the worker */

let requestId = 0;

let pendingReject: ((error: Error) => void) | null = null;

function failPending(message: string) {
  pendingReject?.(new Error(message));
  pendingReject = null;
}

/** Abort the in-flight request by replacing the worker outright — the only
 * way to stop a synchronous loop. Cheap: the worker holds no state. */
function cancelWork() {
  if (!pendingReject) return;
  worker.terminate();
  worker = spawnWorker();
  failPending('Cancelled.');
}

function ask<T>(
  message: Record<string, unknown>,
  key: 'result' | 'scan',
  onProgress?: (fraction: number, label: string) => void,
): Promise<T> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const target = worker;
    const onMessage = (event: MessageEvent) => {
      if (event.data.id !== id) return;
      if (event.data.kind === 'progress') {
        onProgress?.(event.data.fraction, event.data.label);
        return;
      }
      target.removeEventListener('message', onMessage);
      pendingReject = null;
      if (event.data.ok) resolve(event.data[key] as T);
      else reject(new Error(event.data.error));
    };
    pendingReject = (error) => {
      target.removeEventListener('message', onMessage);
      reject(error);
    };
    target.addEventListener('message', onMessage);
    target.postMessage({ ...message, id });
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
      (fraction, label) => {
        setStatus(label, fraction);
        overlay.classList.add('can-cancel');
      },
    );
    state.result = result;
    state.highlight = null;
    state.selected = null;
    state.hover = null;
    state.cursor = null;
    state.viewerFor = null;
    document.body.classList.add('has-result');

    drawGridPreview(previewCanvas, result.cellMeans, rows, cols);
    drawMosaic(cleanMosaic, result.choice, tiles, rows, cols);
    paintMosaicPanel();
    cellReadout.textContent = 'Arrow keys move between cells when the mosaic is focused.';
    buildExportOptions();
    syncHash();
    renderStats(result);
    renderConsole(result, params);
    renderClusters(result, tiles);
    renderBenchmark(result);
    renderInsights(result);
    renderClusterDetail();

    overlay.classList.add('hidden');
    await showView(state.view, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'Cancelled.') showError(message);
    // Cancelling leaves the previous result on screen, if there was one.
    overlay.classList.add('hidden');
  } finally {
    state.busy = false;
    setBusy(false);
  }
}

runButton.addEventListener('click', () => void run());
cancelButton.addEventListener('click', cancelWork);

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
  document.querySelectorAll<HTMLElement>('#view-switch button').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  stageFrame.setAttribute('aria-labelledby', `tab-${view}`);
  stageCaption.textContent = VIEW_CAPTIONS[view];

  const explore = view === 'mosaic';
  const compare = view === 'compare';
  zoomCanvas.hidden = !explore;
  viewerHud.hidden = !explore;
  viewerTools.hidden = !explore;
  for (const el of [compareHandle, compareLeft, compareRight]) el.hidden = !compare;
  stageCanvas.style.visibility = explore ? 'hidden' : '';
  syncHash();

  const result = state.result;
  const tiles = state.tiles;
  if (!result || !tiles) return;
  const { rows, cols } = result.stats;
  const t = tiles.size;

  if (view !== 'animation') {
    state.animation?.stop();
    scrub.classList.remove('on');
  }
  if (!explore && viewer.isDiving()) viewer.reset(false);

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
      ensureViewer(result, tiles);
      break;
    case 'compare':
      drawCompare();
      break;
  }
}

/* ------------------------------------------------------- deep-zoom viewer */

const viewer: Viewer = createViewer(zoomCanvas, viewerHud, {
  reducedMotion: () => reducedMotion.matches,
});

function ensureViewer(result: PipelineResult, tiles: TileSet) {
  if (state.viewerFor !== result) {
    state.viewerFor = result;
    viewer.setData({
      mosaic: cleanMosaic,
      choice: result.choice,
      cellCluster: result.cellCluster,
      cellMeans: result.cellMeans,
      rows: result.stats.rows,
      cols: result.stats.cols,
      tileSize: tiles.size,
      lod: state.lod,
    });
    viewer.setIsolate(state.selected);
  } else {
    viewer.resize();
  }
}

$('zoom-in').addEventListener('click', () => viewer.zoomBy(1.6));
$('zoom-out').addEventListener('click', () => viewer.zoomBy(1 / 1.6));
$('zoom-fit').addEventListener('click', () => viewer.reset(true));
const diveButton = $<HTMLButtonElement>('zoom-dive');
diveButton.addEventListener('click', async () => {
  if (viewer.isDiving()) return;
  diveButton.disabled = true;
  await viewer.dive();
  diveButton.disabled = false;
});

/* --------------------------------------------------------- before / after */

/** The stage canvas is letterboxed inside the frame (object-fit: contain),
 * so the divider has to live inside the picture's box, not the frame's. */
function pictureBox() {
  const frame = stageFrame.getBoundingClientRect();
  const ratio = stageCanvas.width / Math.max(1, stageCanvas.height);
  let w = frame.width;
  let h = w / ratio;
  if (h > frame.height) {
    h = frame.height;
    w = h * ratio;
  }
  return { left: (frame.width - w) / 2, top: (frame.height - h) / 2, w, h };
}

function drawCompare() {
  const result = state.result;
  const tiles = state.tiles;
  if (!result || !tiles || !state.target) return;
  const { rows, cols } = result.stats;
  const w = cols * tiles.size;
  const h = rows * tiles.size;
  if (stageCanvas.width !== w || stageCanvas.height !== h || state.view === 'compare') {
    const ctx = fitStage(w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(state.target, 0, 0, w, h);
    const x = Math.round(w * state.comparePos);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, w - x, h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cleanMosaic, 0, 0);
    ctx.restore();
    ctx.fillStyle = 'rgba(92, 225, 242, 0.95)';
    ctx.fillRect(x - 1, 0, 2, h);
  }
  layoutCompare();
}

function layoutCompare() {
  const box = pictureBox();
  compareHandle.style.left = `${box.left + box.w * state.comparePos}px`;
  compareHandle.style.top = `${box.top}px`;
  compareHandle.style.height = `${box.h}px`;
  compareLeft.style.left = `${box.left + 10}px`;
  compareLeft.style.top = `${box.top + 10}px`;
  compareRight.style.right = `${stageFrame.clientWidth - box.left - box.w + 10}px`;
  compareRight.style.top = `${box.top + 10}px`;
  const pct = Math.round(state.comparePos * 100);
  compareHandle.setAttribute('aria-valuenow', String(pct));
  compareHandle.setAttribute('aria-valuetext', `${pct}% target, ${100 - pct}% mosaic`);
}

function setComparePos(pos: number) {
  state.comparePos = Math.min(1, Math.max(0, pos));
  if (state.view === 'compare') drawCompare();
}

stageFrame.addEventListener('pointerdown', (event) => {
  if (state.view !== 'compare' || (event.target as HTMLElement).closest('button')) return;
  const move = (e: PointerEvent) => {
    const box = pictureBox();
    const rect = stageFrame.getBoundingClientRect();
    setComparePos((e.clientX - rect.left - box.left) / box.w);
  };
  move(event);
  compareHandle.focus({ preventScroll: true });
  stageFrame.setPointerCapture(event.pointerId);
  const up = () => {
    stageFrame.removeEventListener('pointermove', move);
    stageFrame.removeEventListener('pointerup', up);
    stageFrame.removeEventListener('pointercancel', up);
  };
  stageFrame.addEventListener('pointermove', move);
  stageFrame.addEventListener('pointerup', up);
  stageFrame.addEventListener('pointercancel', up);
});

compareHandle.addEventListener('keydown', (event) => {
  const step = event.shiftKey ? 0.1 : 0.02;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') setComparePos(state.comparePos - step);
  else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') setComparePos(state.comparePos + step);
  else if (event.key === 'Home') setComparePos(0);
  else if (event.key === 'End') setComparePos(1);
  else return;
  event.preventDefault();
});

$('view-switch').addEventListener('keydown', (event) => {
  const tabs = Array.from($('view-switch').querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  const next =
    event.key === 'ArrowRight' ? (i + 1) % tabs.length
    : event.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
    : event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
    : -1;
  if (next < 0) return;
  event.preventDefault();
  // Manual activation: arrows move focus, Enter/Space picks the view, so
  // sweeping past "Animation" doesn't restart the fly-in.
  tabs.forEach((t, n) => (t.tabIndex = n === next ? 0 : -1));
  tabs[next].focus();
});

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

downloadButton.addEventListener('click', async () => {
  const result = state.result;
  const lod = state.lod;
  const plan = state.exportPlan;
  if (!result || !plan) return;
  const name = `mosaic-${state.targetName.replace(/\.[^.]+$/, '')}`;
  downloadButton.disabled = true;
  exportSelect.disabled = true;
  try {
    let blob: Blob;
    if (exportSelect.value === 'hires' && plan.hires && lod) {
      blob = await exportHiRes(result.choice, result.stats.rows, result.stats.cols, plan, lod, (f) => {
        exportNote.textContent = `Composing high-detail PNG… ${Math.round(f * 100)}%`;
      });
      saveBlob(blob, `${name}-${plan.width}x${plan.height}.png`);
      exportNote.textContent = `Saved ${plan.width} × ${plan.height} px (${(blob.size / 1e6).toFixed(1)} MB) — composed from full-detail tiles, not upscaled.`;
    } else {
      blob = await exportNative(cleanMosaic);
      saveBlob(blob, `${name}.png`);
      exportNote.textContent = `Saved ${cleanMosaic.width} × ${cleanMosaic.height} px (${(blob.size / 1e6).toFixed(1)} MB).`;
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    exportNote.textContent = '';
  } finally {
    downloadButton.disabled = !state.result;
    exportSelect.disabled = !state.result;
  }
});

function buildExportOptions() {
  const result = state.result;
  const tiles = state.tiles;
  if (!result || !tiles) return;
  const { rows, cols } = result.stats;
  const plan = planExport(rows, cols, tiles.size, state.lod);
  state.exportPlan = plan;
  const opts = [`<option value="native">Native · ${cols * tiles.size}×${rows * tiles.size}</option>`];
  if (plan.hires) opts.push(`<option value="hires">High detail · ${plan.width}×${plan.height}</option>`);
  exportSelect.innerHTML = opts.join('');
  exportSelect.value = plan.hires ? 'hires' : 'native';
  exportSelect.disabled = state.busy;
}

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

let replayFor: PipelineResult | null = null;
let replayAuto: PipelineResult | null = null;

const replay: Replay = createReplay(replayCanvas, {
  reducedMotion: () => reducedMotion.matches,
  onChange: (st: ReplayState) => {
    const live = st.frames >= 2;
    replayScrub.disabled = !live;
    replayPlay.disabled = !live;
    replayScrub.max = String(Math.max(0, st.frames - 1));
    replayScrub.value = String(st.t);
    replayPlay.textContent = st.playing ? 'Pause' : st.t >= st.frames - 1 ? 'Replay' : 'Play';
    replayReadout.textContent = st.frames
      ? `iteration ${st.iteration} / ${st.frames} · inertia ${fmt(st.inertia)}${st.moved ? ` · ${st.moved} moved` : st.t >= st.frames - 1 ? ' · converged' : ''}`
      : '—';
    replayScrub.setAttribute('aria-valuetext', replayReadout.textContent ?? '');
  },
});
replayPlay.addEventListener('click', () => replay.toggle());
replayScrub.addEventListener('input', () => replay.seek(Number(replayScrub.value)));

// Play once, the first time the panel is actually in view for each run.
if ('IntersectionObserver' in window) {
  new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting) || !state.result) return;
      if (replayAuto === state.result || reducedMotion.matches) return;
      replayAuto = state.result;
      replay.seek(0);
      replay.play();
    },
    { threshold: 0.5 },
  ).observe($('replay-panel'));
}

function renderInsights(result: PipelineResult) {
  const s = result.stats;

  drawFeatureSpace(spaceCanvas, result.scatter, result.labels, result.tileColors, s.k, {
    highlight: state.highlight,
  });
  if (replayFor === result) replay.resize();
  else {
    replayFor = result;
    replay.setData(result.scatter, result.tileColors, s.trace, s.k);
  }
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
    figure.dataset.cluster = String(c);
    figure.tabIndex = 0;
    figure.setAttribute('role', 'button');
    figure.setAttribute('aria-pressed', 'false');
    figure.setAttribute(
      'aria-label',
      `Cluster ${c}, ${result.stats.clusterSizes[c]} tiles. Press to follow it through the mosaic.`,
    );
    canvas.className = 'pixelated';
    canvas.setAttribute('aria-hidden', 'true');
    const caption = document.createElement('figcaption');
    caption.innerHTML = `cluster ${String(c).padStart(2, '0')} <span>${
      result.stats.clusterSizes[c]
    } tiles</span>`;
    figure.append(canvas, caption);

    // Hover previews a cluster in the feature-space plot; selecting keeps it
    // there and follows it through the mosaic too.
    figure.addEventListener('pointerenter', () => setHover(c));
    figure.addEventListener('pointerleave', () => setHover(null));
    figure.addEventListener('click', () => selectCluster(state.selected === c ? null : c));
    figure.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectCluster(state.selected === c ? null : c);
      }
    });
    container.appendChild(figure);
  }
}

function setHover(cluster: number | null) {
  state.hover = cluster;
  redrawSpace();
}

function redrawSpace() {
  if (!state.result) return;
  const cluster = state.hover ?? state.selected;
  if (state.highlight === cluster) return;
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

function selectCluster(cluster: number | null) {
  state.selected = cluster;
  document.querySelectorAll<HTMLElement>('#clusters .cluster').forEach((el) => {
    const on = Number(el.dataset.cluster) === cluster;
    el.classList.toggle('selected', on);
    el.setAttribute('aria-pressed', String(on));
  });
  redrawSpace();
  paintMosaicPanel();
  viewer.setIsolate(cluster);
  renderClusterDetail();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.selected !== null) selectCluster(null);
});

function renderClusterDetail() {
  const result = state.result;
  const c = state.selected;
  if (!result) {
    clusterDetail.innerHTML = '<p class="empty">Generate a mosaic to explore its clusters.</p>';
    return;
  }
  if (c === null) {
    clusterDetail.innerHTML =
      '<p class="empty">Select a cluster to see where its tiles landed in the mosaic.</p>';
    return;
  }
  const s = result.stats;
  let routed = 0;
  const used = new Set<number>();
  for (let i = 0; i < result.cellCluster.length; i++) {
    if (result.cellCluster[i] !== c) continue;
    routed++;
    used.add(result.choice[i]);
  }
  const size = s.clusterSizes[c];
  const idle = routed === 0 ? '<p class="empty-note">None of this target\'s cells fell into this cluster — try another.</p>' : '';
  const rgb = `rgb(${result.clusterColors[c * 3]}, ${result.clusterColors[c * 3 + 1]}, ${result.clusterColors[c * 3 + 2]})`;
  clusterDetail.innerHTML = `
    <span class="swatch" style="background:${rgb}" aria-hidden="true"></span>
    <dl>
      <div><dt>cluster</dt><dd>${String(c).padStart(2, '0')}</dd></div>
      <div><dt>library share</dt><dd>${size} tiles · ${((size / Math.max(1, s.tiles)) * 100).toFixed(0)}%</dd></div>
      <div><dt>cells routed here</dt><dd>${routed.toLocaleString()} · ${((routed / Math.max(1, s.cells)) * 100).toFixed(0)}% of the mosaic</dd></div>
      <div><dt>tiles actually used</dt><dd>${used.size} of ${size}</dd></div>
    </dl>
    ${idle}
    <button type="button" class="btn btn-ghost" id="cluster-clear">Clear <kbd>Esc</kbd></button>`;
  $('cluster-clear').addEventListener('click', () => selectCluster(null));
}

/** The mosaic panel: the picture, plus whichever overlays are live —
 * cluster isolation and the keyboard cell cursor. */
function paintMosaicPanel() {
  const result = state.result;
  const tiles = state.tiles;
  if (!result || !tiles) return;
  const { rows, cols } = result.stats;
  const t = tiles.size;
  mosaicCanvas.width = cleanMosaic.width;
  mosaicCanvas.height = cleanMosaic.height;
  const ctx = mosaicCanvas.getContext('2d')!;
  ctx.drawImage(cleanMosaic, 0, 0);
  if (state.selected !== null) {
    ctx.fillStyle = 'rgba(4, 6, 10, 0.8)';
    for (let i = 0; i < rows * cols; i++) {
      if (result.cellCluster[i] === state.selected) continue;
      ctx.fillRect((i % cols) * t, Math.floor(i / cols) * t, t, t);
    }
  }
  if (state.cursor) {
    ctx.strokeStyle = 'rgba(92, 225, 242, 1)';
    ctx.lineWidth = Math.max(1.5, t / 8);
    ctx.strokeRect(state.cursor.col * t + ctx.lineWidth / 2, state.cursor.row * t + ctx.lineWidth / 2, t - ctx.lineWidth, t - ctx.lineWidth);
  }
}

/** Keyboard route to the same per-cell decision the hover tooltip shows. */
mosaicCanvas.addEventListener('keydown', (event) => {
  const result = state.result;
  if (!result) return;
  const { rows, cols } = result.stats;
  const cur = state.cursor ?? { row: Math.floor(rows / 2), col: Math.floor(cols / 2) };
  const step = event.shiftKey ? 5 : 1;
  if (event.key === 'ArrowLeft') cur.col = Math.max(0, cur.col - step);
  else if (event.key === 'ArrowRight') cur.col = Math.min(cols - 1, cur.col + step);
  else if (event.key === 'ArrowUp') cur.row = Math.max(0, cur.row - step);
  else if (event.key === 'ArrowDown') cur.row = Math.min(rows - 1, cur.row + step);
  else if (event.key === 'Escape') {
    state.cursor = null;
    paintMosaicPanel();
    return;
  } else return;
  event.preventDefault();
  state.cursor = { ...cur };
  paintMosaicPanel();
  const i = cur.row * cols + cur.col;
  const cluster = Math.max(0, result.cellCluster[i]);
  cellReadout.textContent =
    `Cell r${cur.row} · c${cur.col} asked for rgb(${result.cellMeans[i * 3]}, ${result.cellMeans[i * 3 + 1]}, ${result.cellMeans[i * 3 + 2]}). ` +
    `Routed to cluster ${String(cluster).padStart(2, '0')}, searched ${result.cellCandidates[i]} of ${result.stats.tiles} tiles, ` +
    `got tile #${result.choice[i]} at distance ${result.cellDist[i].toFixed(1)}` +
    (result.cellDist[i] > result.cellNearest[i] + 1e-6 ? ` (best available ${result.cellNearest[i].toFixed(1)}, already taken).` : '.');
});
mosaicCanvas.addEventListener('blur', () => {
  if (state.cursor) {
    state.cursor = null;
    paintMosaicPanel();
  }
});

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

function setStatus(message: string, fraction?: number) {
  statusText.textContent = message;
  overlay.classList.remove('hidden');
  overlay.classList.toggle('has-progress', fraction !== undefined);
  overlay.classList.remove('can-cancel');
  if (fraction !== undefined) {
    progressFill.style.width = `${Math.round(fraction * 100)}%`;
    progressBar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  }
}

function setBusy(busy: boolean) {
  const blocked = busy || state.recording;
  runButton.disabled = blocked;
  runButton.textContent = busy && !state.recording ? 'Working…' : 'Generate mosaic';
  replayButton.disabled = blocked || !state.result;
  downloadButton.disabled = blocked || !state.result;
  exportSelect.disabled = blocked || !state.result;
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
    if (state.view === 'mosaic') viewer.resize();
    if (state.view === 'compare') layoutCompare();
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

/* ---------------------------------------------------- presets and sharing */

function currentPreset(): Preset {
  const p = readParams();
  return {
    k: p.k,
    tile: p.tileSize,
    cols: p.gridCols,
    variety: p.variety,
    feature: p.feature,
    compare: p.compare,
    target: PRESETS.some((x) => x.id === state.targetName) ? state.targetName : 'sunset',
    view: state.view,
  };
}

/** Keep the address bar equal to the current settings, so the URL is always
 * a valid share link and a reload restores the run. */
function syncHash() {
  try {
    history.replaceState(null, '', `#${encodePreset(currentPreset())}`);
  } catch {
    /* sandboxed frames can refuse history writes; sharing still works via the button */
  }
}

function applyPreset(p: Partial<Preset>) {
  const set = (id: string, value: number | undefined) => {
    if (value === undefined) return;
    const input = $<HTMLInputElement>(id);
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
  };
  set('in-k', p.k);
  set('in-tile', p.tile);
  set('in-cols', p.cols);
  set('in-variety', p.variety);
  if (p.feature) {
    state.feature = p.feature;
    $('feature-toggle')
      .querySelectorAll<HTMLElement>('button')
      .forEach((b) => b.classList.toggle('active', b.dataset.feature === p.feature));
  }
  if (p.compare !== undefined) $<HTMLInputElement>('in-compare').checked = p.compare;
}

function buildRecipes() {
  const row = $('recipes');
  RECIPES.forEach((recipe) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = recipe.label;
    button.title = recipe.hint;
    button.addEventListener('click', () => {
      if (state.busy) return;
      applyPreset(recipe.set);
      void run();
    });
    row.appendChild(button);
  });
}

shareButton.addEventListener('click', async () => {
  syncHash();
  const custom =
    !PRESETS.some((x) => x.id === state.targetName) || state.userFiles || state.googleUrls;
  let copied = false;
  try {
    await navigator.clipboard.writeText(location.href);
    copied = true;
  } catch {
    /* clipboard needs a secure context and a user gesture; fall through */
  }
  exportNote.textContent =
    (copied ? 'Link copied.' : 'Copy the address bar — it already holds your settings.') +
    (custom ? ' Uploaded photos stay on your machine, so the link opens with a built-in target and library.' : '');
});

/* -------------------------------------------------------------------- boot */



async function boot() {
  buildPresetButtons();
  buildRecipes();
  const shared = decodePreset(
    location.hash,
    PRESETS.map((p) => p.id),
    VIEWS,
  );
  applyPreset(shared);
  if (shared.view) state.view = shared.view as StageView;
  try {
    await setTargetFromPreset(shared.target ?? 'sunset');
    await run();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    overlay.classList.add('hidden');
  }
}

void boot();
