"""Gradio web UI for the mosaic pipeline.

Wraps the existing modular pipeline (grid → sources → features → cluster
→ match → render) in a browser interface with image upload widgets,
sliders, and live output previews.

    python -m src.ui          # launches on http://127.0.0.1:7860
"""

import tempfile
from pathlib import Path

import gradio as gr
import numpy as np
from PIL import Image

from . import cluster, features, grid, matching, render, sources


ROOT = Path(__file__).resolve().parent.parent
DEMO_SOURCES = ROOT / "assets/sources"
DEMO_TARGET = ROOT / "assets/targets/demo_sunset.png"


def _run_pipeline(target_img, source_files, tile_size, grid_cols, k,
                  feature, variety):
    """Run the full pipeline and return output images + metadata."""
    if target_img is None:
        raise gr.Error("Please upload a target image.")

    # gr.File(file_count="directory") hands back a list of file paths;
    # with nothing uploaded we fall back to the bundled demo library.
    if source_files:
        tile_paths = source_files
    elif DEMO_SOURCES.is_dir():
        tile_paths = sorted(DEMO_SOURCES.iterdir())
    else:
        raise gr.Error("Please select a folder of source images.")

    # Save uploaded target to a temp file (Gradio gives us a PIL Image)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        target_img.save(tmp.name)
        target_path = tmp.name

    out_dir = Path(tempfile.mkdtemp(prefix="mosaic_"))

    # 1. Grid the target
    cells, rows, cols = grid.load_target(
        target_path, int(tile_size), int(grid_cols))
    grid_preview = _cells_to_image(cells, rows, cols, int(tile_size))

    # 2. Load source tiles
    try:
        tiles, paths = sources.load_tiles_from_paths(tile_paths, int(tile_size))
    except ValueError as exc:
        raise gr.Error(str(exc)) from exc

    # 3. Extract features
    tile_feats = features.extract(tiles, feature)
    cell_feats = features.extract(cells, feature)

    # 4. Cluster
    km = cluster.cluster_tiles(tile_feats, int(k))
    sizes = [int((km.labels_ == c).sum()) for c in range(km.n_clusters)]
    contact_sheets = cluster.save_contact_sheets(
        tiles, km.labels_, int(tile_size), out_dir / "clusters")

    # 5. Match cells to tiles (cluster-accelerated)
    choice = matching.match_clustered(cell_feats, tile_feats, km, float(variety))

    # 6. Render mosaic
    mosaic_path = render.render_mosaic(
        choice, tiles, rows, cols, int(tile_size), out_dir / "mosaic.png")
    mosaic_img = Image.open(mosaic_path)

    info = (
        f"Grid: {rows}×{cols} ({len(cells)} cells)\n"
        f"Tiles: {len(tiles)} sources\n"
        f"Clusters: k={km.n_clusters}, sizes={sizes}\n"
        f"Features: {feature} ({tile_feats.shape[1]} dims)\n"
        f"Variety: {variety}\n"
        f"Unique tiles used: {len(set(choice.tolist()))} of {len(tiles)}"
    )

    return grid_preview, mosaic_img, info, [str(p) for p in contact_sheets]


def _cells_to_image(cells, rows, cols, tile_size):
    """Render cell mean colors as a blocky preview (same logic as render_grid_preview)."""
    means = cells.reshape(len(cells), -1, 3).mean(axis=1).astype(np.uint8)
    blocks = means.reshape(rows, cols, 1, 1, 3)
    canvas = np.broadcast_to(
        blocks, (rows, cols, tile_size, tile_size, 3)
    ).transpose(0, 2, 1, 3, 4).reshape(rows * tile_size, cols * tile_size, 3)
    return Image.fromarray(np.ascontiguousarray(canvas))


def build_app():
    """Build and return the Gradio interface."""

    with gr.Blocks(title="Mosaic Generator") as app:
        gr.Markdown("# 🎨 Mosaic Generator")
        gr.Markdown(
            "Upload a **target image** to reconstruct, and optionally a "
            "**folder of source images** to build it from (leave empty to use "
            "the bundled demo library). The pipeline clusters the sources by "
            "visual similarity (k-means), then assigns each mosaic cell to the "
            "best-matching source tile."
        )

        with gr.Row():
            with gr.Column(scale=1):
                target_input = gr.Image(
                    label="Target Image — the image to reconstruct",
                    type="pil",
                    value=str(DEMO_TARGET) if DEMO_TARGET.exists() else None)
                source_input = gr.File(
                    label="Source Images — folder of tiles (optional)",
                    file_count="directory", type="filepath")

            with gr.Column(scale=1):
                tile_size_slider = gr.Slider(
                    minimum=8, maximum=64, step=2, value=16,
                    label="Tile Size (px)")
                grid_cols_slider = gr.Slider(
                    minimum=16, maximum=128, step=4, value=48,
                    label="Grid Columns")
                k_slider = gr.Slider(
                    minimum=2, maximum=32, step=1, value=8,
                    label="Clusters (k)")
                feature_dropdown = gr.Dropdown(
                    choices=list(features.EXTRACTORS.keys()),
                    value="mean_rgb", label="Feature Type")
                variety_slider = gr.Slider(
                    minimum=0.0, maximum=1.0, step=0.05, value=0.5,
                    label="Variety (tile diversity)")

        generate_btn = gr.Button("🚀 Generate Mosaic", variant="primary")

        with gr.Row():
            grid_preview_out = gr.Image(label="Grid Preview (cell mean colors)")
            mosaic_out = gr.Image(label="Mosaic Result")
            info_out = gr.Textbox(label="Pipeline Info", lines=8)

        clusters_out = gr.Gallery(
            label="Cluster contact sheets — what k-means grouped together",
            columns=8, height=200)

        generate_btn.click(
            fn=_run_pipeline,
            inputs=[target_input, source_input, tile_size_slider,
                    grid_cols_slider, k_slider, feature_dropdown, variety_slider],
            outputs=[grid_preview_out, mosaic_out, info_out, clusters_out],
        )

    return app


if __name__ == "__main__":
    app = build_app()
    # Gradio 6 takes the theme at launch time, not on Blocks.
    app.launch(server_name="127.0.0.1", server_port=7860,
               theme=gr.themes.Soft())
