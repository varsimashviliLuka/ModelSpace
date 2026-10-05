"""
model_service.py

Inspects an extracted archive directory and determines:
  - The main 3D model file to load
  - The loader type required (glb, gltf, obj, unsupported)
  - Associated texture/material files
  - Whether the format is browser-renderable or needs conversion
  - Whether animation data is likely present (heuristic for GLB/GLTF)
  - For OBJ: parses MTL, resolves texture paths, patches MTL if needed

Public API:
    detect(extract_dir, file_entries) -> dict
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

# ------------------------------------------------------------------ #
# Format priority & loader mapping
# ------------------------------------------------------------------ #

MODEL_PRIORITY: list[str] = ["glb", "gltf", "obj", "fbx", "blend"]
BROWSER_RENDERABLE: frozenset[str] = frozenset({"glb", "gltf", "obj"})

# Ignore app-generated files left over from older experiments.
INTERNAL_DIR_PREFIX: str = "_modelspace/"

LOADER_MAP: dict[str, str] = {
    "glb":   "GLTFLoader",
    "gltf":  "GLTFLoader",
    "obj":   "OBJLoader",
    "fbx":   "unsupported",
    "blend": "unsupported",
}

UNSUPPORTED_HINTS: dict[str, str] = {
    "fbx": (
        "FBX files cannot be reliably rendered in the browser. "
        "Please export your model as GLB or GLTF from your 3D application "
        "(File > Export > glTF 2.0 in Blender)."
    ),
    "blend": (
        ".blend files cannot be opened in the browser. "
        "Open your file in Blender and export it as GLB: "
        "File > Export > glTF 2.0, select 'glTF Binary (.glb)'."
    ),
}

TEXTURE_EXTENSIONS: frozenset[str] = frozenset(
    {"png", "jpg", "jpeg", "webp", "bmp", "tga", "hdr", "exr", "ktx", "ktx2", "basis"}
)

# MTL texture directives we care about
_MTL_TEX_DIRECTIVES = re.compile(
    r"^\s*(?:map_Kd|map_Ks|map_Ka|map_Ke|map_Bump|bump|map_d|disp|decal)\s+(.+)$",
    re.IGNORECASE | re.MULTILINE,
)


# ------------------------------------------------------------------ #
# Public entry point
# ------------------------------------------------------------------ #

def detect(extract_dir: Path, file_entries: list[dict]) -> dict:
    """
    Analyse the extracted files and return a detection dict.

    Returns a dict with keys:
        main_file      : str | None
        loader         : str | None
        format         : str | None
        renderable     : bool
        textures       : list[str]   — all texture file relative paths
        mtl_file       : str | None
        resource_base  : str | None  — URL base dir for MTL texture resolution
        has_animation  : bool
        error          : str | None
        hint           : str | None
        all_models     : list[str]
    """
    paths_by_ext: dict[str, list[str]] = _group_by_ext(file_entries)

    chosen_ext, chosen_rel = _pick_main_model(paths_by_ext)

    if chosen_ext is None:
        for ext in ("blend", "fbx"):
            if paths_by_ext.get(ext):
                return _unsupported_result(ext, paths_by_ext[ext][0])

        return {
            "main_file": None, "loader": None, "format": None,
            "renderable": False, "textures": [], "mtl_file": None,
            "resource_base": None, "has_animation": False,
            "error": "No recognisable 3D model file found in the archive.",
            "hint": "Supported formats: .glb, .gltf, .obj  (also detects: .fbx, .blend)",
            "all_models": _all_model_files(paths_by_ext),
        }

    if chosen_ext not in BROWSER_RENDERABLE:
        return _unsupported_result(chosen_ext, chosen_rel)

    # ---- All texture files ----
    texture_files = [
        e["path"] for e in file_entries
        if _ext(e["path"]) in TEXTURE_EXTENSIONS
    ]

    # ---- OBJ-specific: MTL resolution + texture patching ----
    mtl_file: str | None = None
    resource_base: str | None = None

    if chosen_ext == "obj":
        mtl_file, resource_base = _resolve_obj_package(
            extract_dir, chosen_rel,
            paths_by_ext.get("mtl", []),
            texture_files,
        )

    # ---- Animation heuristic ----
    has_animation = False
    if chosen_ext in ("glb", "gltf"):
        has_animation = _probe_gltf_animations(extract_dir / chosen_rel, chosen_ext)

    return {
        "main_file":     chosen_rel,
        "loader":        LOADER_MAP.get(chosen_ext, "unsupported"),
        "format":        chosen_ext,
        "renderable":    True,
        "textures":      texture_files,
        "mtl_file":      mtl_file,
        "resource_base": resource_base,
        "has_animation": has_animation,
        "error":         None,
        "hint":          None,
        "all_models":    _all_model_files(paths_by_ext),
    }


# ------------------------------------------------------------------ #
# OBJ / MTL package resolution
# ------------------------------------------------------------------ #

def _resolve_obj_package(
    extract_dir: Path,
    obj_rel: str,
    mtl_candidates: list[str],
    texture_files: list[str],
) -> tuple[str | None, str | None]:
    """
    Find the best MTL for the given OBJ, then:
    1. Parse the MTL for texture references.
    2. Try to match each reference against extracted texture files
       (case-insensitive, basename match, fuzzy fallback).
    3. Patch the MTL in-place to use the correct relative paths so
       Three.js MTLLoader resolves them properly.
    4. Return (mtl_relative_path, resource_base_relative_path).

    resource_base is the relative directory of the MTL file so the
    viewer can set MTLLoader.setResourcePath() correctly.
    """
    if not mtl_candidates:
        return None, None

    obj_dir = str(Path(obj_rel).parent)

    # Prefer MTL in the same directory as the OBJ.
    same_dir = [m for m in mtl_candidates if str(Path(m).parent) == obj_dir]
    mtl_rel  = same_dir[0] if same_dir else mtl_candidates[0]
    mtl_abs  = extract_dir / mtl_rel

    if not mtl_abs.exists():
        return mtl_rel, str(Path(mtl_rel).parent)

    # Build a lookup: lowercase_basename -> relative_path for all textures.
    tex_lookup: dict[str, str] = {}
    for t in texture_files:
        tex_lookup[Path(t).name.lower()] = t

    # Parse MTL and collect referenced texture names.
    try:
        mtl_text = mtl_abs.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return mtl_rel, str(Path(mtl_rel).parent)

    refs = _MTL_TEX_DIRECTIVES.findall(mtl_text)
    if not refs:
        return mtl_rel, str(Path(mtl_rel).parent)

    # Build patch map: original_ref -> corrected_basename_only
    patch_map: dict[str, str] = {}
    for raw_ref in refs:
        raw_ref = raw_ref.strip()
        ref_name = Path(raw_ref.replace("\\", "/")).name
        ref_lower = ref_name.lower()

        # Exact match
        if ref_lower in tex_lookup:
            correct_rel = tex_lookup[ref_lower]
        else:
            # Fuzzy: match stem ignoring extension differences (e.g. .TGA vs .png)
            ref_stem = Path(ref_name).stem.lower()
            match = next(
                (v for k, v in tex_lookup.items() if Path(k).stem.lower() == ref_stem),
                None,
            )
            correct_rel = match  # None if no match at all

        if correct_rel is None:
            continue  # can't fix this reference

        # Determine the path relative to the MTL directory so the loader can find it.
        mtl_dir = Path(mtl_rel).parent
        try:
            corrected_path_from_mtl = Path(correct_rel).relative_to(mtl_dir)
        except ValueError:
            # Texture is outside the MTL dir — use relative path from extract root.
            # We'll later adjust resource_base to extract root.
            corrected_path_from_mtl = Path(correct_rel)

        corrected_str = corrected_path_from_mtl.as_posix()
        if raw_ref != corrected_str:
            patch_map[raw_ref] = corrected_str

    # Patch the MTL file if anything changed.
    if patch_map:
        new_text = mtl_text
        for old, new in patch_map.items():
            # Replace only the path part after the directive keyword.
            new_text = new_text.replace(old, new)
        try:
            mtl_abs.write_text(new_text, encoding="utf-8")
        except OSError:
            pass  # non-fatal — viewer may still work with originals

    resource_base = str(Path(mtl_rel).parent)
    return mtl_rel, resource_base


# ------------------------------------------------------------------ #
# Internal helpers
# ------------------------------------------------------------------ #

def _is_internal_path(path: str) -> bool:
    p = path.replace("\\", "/").lstrip("/")
    return p.startswith(INTERNAL_DIR_PREFIX)


def _group_by_ext(file_entries: list[dict]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for entry in file_entries:
        path = entry["path"]
        if _is_internal_path(path):
            continue
        ext = _ext(path)
        result.setdefault(ext, []).append(path)
    return result


def _ext(path: str) -> str:
    return Path(path).suffix.lstrip(".").lower()


def _pick_main_model(paths_by_ext: dict[str, list[str]]) -> tuple[str | None, str | None]:
    for ext in MODEL_PRIORITY:
        candidates = paths_by_ext.get(ext, [])
        if candidates:
            candidates_sorted = sorted(candidates, key=lambda p: (p.count("/"), p))
            return ext, candidates_sorted[0]
    return None, None


def _all_model_files(paths_by_ext: dict[str, list[str]]) -> list[str]:
    result = []
    for ext in MODEL_PRIORITY:
        result.extend(paths_by_ext.get(ext, []))
    return result


def _unsupported_result(ext: str, file_path: str) -> dict:
    return {
        "main_file": None, "loader": "unsupported", "format": ext,
        "renderable": False, "textures": [], "mtl_file": None,
        "resource_base": None, "has_animation": False,
        "error": f"The file '{Path(file_path).name}' ({ext.upper()}) cannot be rendered in the browser.",
        "hint": UNSUPPORTED_HINTS.get(ext, f"Convert {ext.upper()} to GLB/GLTF format first."),
        "all_models": [file_path],
    }


def _probe_gltf_animations(abs_path: Path, fmt: str) -> bool:
    try:
        if fmt == "glb":
            return _probe_glb_animations(abs_path)
        return _probe_gltf_json_animations(abs_path)
    except Exception:
        return False


def _probe_glb_animations(path: Path) -> bool:
    with open(path, "rb") as f:
        if f.read(4) != b"glTF":
            return False
        f.read(8)
        chunk_length = int.from_bytes(f.read(4), "little")
        if f.read(4) != b"JSON":
            return False
        data = json.loads(f.read(chunk_length))
    return bool(data.get("animations"))


def _probe_gltf_json_animations(path: Path) -> bool:
    data = json.loads(path.read_text(encoding="utf-8"))
    return bool(data.get("animations"))
