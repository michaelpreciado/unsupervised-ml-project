# Mosaic ML Project — Unsupervised Learning Photo Mosaic Generator

> **Status.** All 12 milestones are done. The pipeline runs end to end from
> the CLI (`src/main.py`), a Gradio UI (`src/ui.py`), and a TypeScript port
> deployed as a browser demo (`web/`). Milestone 12 turned into something
> better than a recorded screencast: both front ends *export* a watermarked
> video of the animation, locally — `--record` on the CLI, MediaRecorder in
> the browser — so the demo regenerates itself for any target and any
> parameters instead of going stale.
>
> A thirteenth thing was added that the plan didn't anticipate and probably
> should have: the browser demo now visualizes the *model*, not just its
> output — Lloyd convergence per iteration, the ten k-means++ restarts, a
> PCA projection of the feature space with cluster hulls and centroids, an
> on-demand inertia/silhouette sweep over k, a per-cell inspector, and a
> ledger pricing what the variety penalty costs. The original plan treated
> clustering as machinery; making the machinery legible turned out to be the
> part worth building.
>
> Two things came out differently than this plan expected, both written up
> in the README:
> - The histogram upgrade in milestone 9 **made mosaics worse**, not better,
>   until the bins were made soft — hard bin edges rate near-identical
>   colors as maximally distant. Fixed and measured.
> - The variety penalty isn't feature-independent. Its scale is tuned to
>   mean-RGB distances and swamps the color signal in 216-dim histogram
>   space; at matched tile diversity the two features are equivalent.
>
> `scripts/evaluate_features.py` reproduces both findings.

## Goal

Build a Python + Pygame application that reconstructs a user-selected
target image as a mosaic, using unsupervised learning (clustering) to
organize a batch of source images, then animates them flying into place.

Purpose: portfolio project demonstrating unsupervised ML for AWS ML
certification prep. Learning-first — code is written by hand, Claude
guides rather than writes.

## Core Concept

1. User selects a **target image** (the "canvas").
2. User provides a **batch of source images** — upload their own folder,
   or pull a batch via web image search.
3. **Unsupervised learning step:** cluster source images by visual
   similarity (color histograms and/or pretrained embeddings, e.g.
   ResNet features) using k-means or similar.
4. **Placement/matching step:** assign clustered tiles to grid positions
   in the target image based on closest color/brightness match.
5. **Visualization step:** animate tiles flying from their start position
   into their final mosaic position using Pygame.

## Tech Stack

- **Language:** Python
- **Image handling:** Pillow and/or OpenCV
- **Clustering (the ML core):** scikit-learn — k-means on color
  histograms or embeddings
- **Visualization/animation:** Pygame (chosen over Streamlit/Gradio for
  full control over tile movement, easing, and timing)

## Design decisions

- **Clustering role: search accelerator.** Grid cells match against
  cluster centroids first, then search only within the winning cluster
  (the idea behind approximate nearest-neighbor search). This makes
  k-means load-bearing, not decorative — and enables a README benchmark:
  brute-force vs. cluster-accelerated matching.
- **Feature progression:** start with mean RGB (3 values/image), then
  upgrade to color histograms, then optionally ResNet embeddings.
  Pipeline works end-to-end at every stage; mosaic quality visibly
  improves with each feature upgrade — that progression is a README
  section.
- **Fixed tile size** (e.g. 32×32 px), not fixed grid count — simplifies
  matching and Pygame rendering.
- **Source images: local folder first.** Web search fetch is deferred to
  polish — it's API keys and rate limits, not ML.

## Milestones

1. Load target image + resize/grid it into tile-sized cells
   (sanity check: render each cell's average color as a blocky image)
2. Source image loader — local folder only
3. Feature extraction — mean RGB first (upgrade path: histogram, embedding)
4. K-means clustering on features — the unsupervised ML core
5. Cluster visualization: contact sheet per cluster; pick k via
   elbow method / silhouette score
6. Matching: cell → nearest centroid → best tile within that cluster
7. Render static mosaic result (sanity check before animating)
8. Pygame animation layer: tiles start scattered, fly into position
9. Feature upgrade pass: histograms / ResNet embeddings, compare results
10. Polish: easing/timing, UI for target selection, optional web fetch
11. README: the ML approach, clustering choice, k selection, feature
    comparison, and how this differs from GA/FAISS photomosaic projects
12. Record a demo video — shipped as an export feature rather than an
    artifact: `--record` (headless, fixed timestep, watermarked) and an
    in-browser MediaRecorder capture of the same animation

## Differentiation from existing similar projects

Most existing photomosaic generators (including genetic-algorithm and
FAISS-based versions, and face-focused tools like Facemo) don't frame
themselves as unsupervised clustering demos, and none combine that with
a live animated tile-placement visual. That combination + a strong
README explaining the algorithm choices is the differentiator here.
