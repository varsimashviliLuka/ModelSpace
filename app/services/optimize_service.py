"""
optimize_service.py

Post-extract optimisations for large model packages.

Currently:
  - Downscale raster textures that exceed MAX_TEXTURE_EDGE so browsers
    (and Quest 3) do not decode multi‑hundred‑MB GPU textures into RAM/VRAM.
"""

from __future__ import annotations

from pathlib import Path

try:
    from PIL import Image
    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False

# Formats Pillow can safely re-encode for the viewer.
_RESIZABLE = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})


def downscale_textures(extract_dir: Path, max_edge: int) -> dict:
    """
    Resize image files under *extract_dir* whose longest side > *max_edge*.

    Returns a summary dict: {resized: int, skipped: int, errors: list[str]}.
    """
    summary: dict = {"resized": 0, "skipped": 0, "errors": []}

    if max_edge <= 0:
        return summary
    if not _PIL_AVAILABLE:
        summary["errors"].append(
            "Pillow not installed — texture downscale skipped. "
            "Run: pip install Pillow"
        )
        return summary
    if not extract_dir.is_dir():
        return summary

    # Avoid decompression-bomb abort on huge source textures.
    Image.MAX_IMAGE_PIXELS = 200_000_000

    for path in extract_dir.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in _RESIZABLE:
            continue
        try:
            with Image.open(path) as img:
                w, h = img.size
                longest = max(w, h)
                if longest <= max_edge:
                    summary["skipped"] += 1
                    continue

                img = img.convert("RGB") if img.mode not in ("RGB", "RGBA", "L") else img
                img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)

                suffix = path.suffix.lower()
                save_kwargs: dict = {}
                if suffix in (".jpg", ".jpeg"):
                    save_kwargs.update(quality=85, optimize=True)
                    if img.mode == "RGBA":
                        img = img.convert("RGB")
                elif suffix == ".png":
                    save_kwargs.update(optimize=True)
                elif suffix == ".webp":
                    save_kwargs.update(quality=85, method=4)

                img.save(path, **save_kwargs)
                summary["resized"] += 1
        except Exception as exc:
            summary["errors"].append(f"{path.name}: {exc}")

    return summary
