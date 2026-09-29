/** Shareable presets: every knob on the page, round-tripped through the URL
 * hash so a link reproduces a run exactly (the pipeline is seeded, so the
 * same link gives the same mosaic).
 *
 * The hash never reaches a server. Uploaded photos can't ride along in a
 * link, so a shared preset always names one of the built-in targets. */

import type { FeatureKind } from './types';

export interface Preset {
  k: number;
  tile: number;
  cols: number;
  variety: number;
  feature: FeatureKind;
  compare: boolean;
  target: string;
  view: string;
}

/** Slider domains — kept next to the decoder so a hand-edited or stale link
 * can never push a value outside what the controls allow. */
export const LIMITS = {
  k: [2, 24, 1],
  tile: [8, 32, 4],
  cols: [16, 96, 4],
  variety: [0, 1, 0.05],
} as const;

const snap = (v: number, [lo, hi, step]: readonly [number, number, number]) =>
  Math.min(hi, Math.max(lo, Math.round((v - lo) / step) * step + lo));

export function encodePreset(p: Preset): string {
  const q = new URLSearchParams({
    k: String(p.k),
    tile: String(p.tile),
    cols: String(p.cols),
    variety: p.variety.toFixed(2),
    feature: p.feature,
    compare: p.compare ? '1' : '0',
    target: p.target,
    view: p.view,
  });
  return q.toString();
}

/** Parse a hash (with or without the leading #). Unknown or malformed fields
 * are dropped rather than throwing. */
export function decodePreset(hash: string, targets: string[], views: string[]): Partial<Preset> {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const out: Partial<Preset> = {};
  const num = (key: string) => {
    const v = q.get(key);
    return v !== null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  };
  const k = num('k');
  if (k !== null) out.k = snap(k, LIMITS.k);
  const tile = num('tile');
  if (tile !== null) out.tile = snap(tile, LIMITS.tile);
  const cols = num('cols');
  if (cols !== null) out.cols = snap(cols, LIMITS.cols);
  const variety = num('variety');
  if (variety !== null) out.variety = Number(snap(variety, LIMITS.variety).toFixed(2));
  const feature = q.get('feature');
  if (feature === 'mean_rgb' || feature === 'histogram') out.feature = feature;
  if (q.has('compare')) out.compare = q.get('compare') === '1';
  const target = q.get('target');
  if (target && targets.includes(target)) out.target = target;
  const view = q.get('view');
  if (view && views.includes(view)) out.view = view;
  return out;
}

/** One-click starting points. Each is a real trade-off, named for what it
 * looks like rather than for the numbers. */
export const RECIPES: { id: string; label: string; hint: string; set: Partial<Preset> }[] = [
  { id: 'balanced', label: 'Balanced', hint: 'The defaults: quick, varied, readable.', set: { k: 8, tile: 16, cols: 48, variety: 0.25, feature: 'mean_rgb' } },
  { id: 'detail', label: 'Fine detail', hint: 'Small tiles, wide grid, little variety penalty.', set: { k: 12, tile: 12, cols: 80, variety: 0.1, feature: 'mean_rgb' } },
  { id: 'painterly', label: 'Painterly', hint: 'Big tiles on a coarse grid; every photo is legible.', set: { k: 6, tile: 28, cols: 28, variety: 0.4, feature: 'mean_rgb' } },
  { id: 'texture', label: 'Texture match', hint: 'Histogram features, so mixed-colour tiles match mixed-colour cells.', set: { k: 10, tile: 16, cols: 48, variety: 0.04, feature: 'histogram' } },
];
