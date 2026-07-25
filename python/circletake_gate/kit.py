"""Character-kit builder: reference stills → SFace embeddings.json.

Output shape (consumed by checks/identity.py and cached under kits/<charId>/)::

    {
      "model": "sface-2021dec",
      "dim": 128,
      "images": [{"file": "...", "embedding": [...128 floats...]}],
      "reference": [...128 floats...]     # spherical mean of the images
    }

Ordering is deterministic (input order preserved, embeddings rounded to a fixed
precision) so rebuilding a kit from the same stills produces a byte-identical
file — locked kits must be reproducible.
"""

from __future__ import annotations

import json
import os
from typing import Any

import cv2
import numpy as np

from . import protocol
from . import thresholds as T
from .checks.identity import FaceEngine, largest_face, qualifying_faces, spherical_mean

EMBEDDING_PRECISION = 8


def build_kit(
    images: list[str],
    out_path: str,
    cache_dir: str | None = None,
) -> dict[str, Any]:
    """Detect the largest face in each image, embed it, and write embeddings.json.

    Images with no usable face are skipped with a warning; at least one usable
    image is required.
    """
    from .models import SFACE, YUNET, ensure_model

    yunet_path = ensure_model(YUNET, cache_dir)
    sface_path = ensure_model(SFACE, cache_dir)
    engine = FaceEngine(yunet_path, sface_path)

    entries: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []

    total = max(1, len(images))
    for i, img_path in enumerate(images):
        protocol.emit("kit", 100.0 * i / total, f"embedding {os.path.basename(img_path)}")
        if not os.path.isfile(img_path):
            skipped.append({"file": img_path, "why": "file not found"})
            protocol.log(f"warning: kit image not found, skipped: {img_path}")
            continue
        bgr = cv2.imread(img_path, cv2.IMREAD_COLOR)
        if bgr is None:
            skipped.append({"file": img_path, "why": "unreadable image"})
            protocol.log(f"warning: could not read kit image, skipped: {img_path}")
            continue
        # Detect at a bounded size so MIN_FACE_SIDE_PX means the same thing for
        # a 6000px still as for a 720p frame.
        h, w = bgr.shape[:2]
        if h > T.METRIC_MAX_HEIGHT:
            scale = T.METRIC_MAX_HEIGHT / float(h)
            bgr = cv2.resize(
                bgr, (max(1, int(round(w * scale))), T.METRIC_MAX_HEIGHT), interpolation=cv2.INTER_AREA
            )
        faces = qualifying_faces(engine.detect(bgr))
        row = largest_face(faces)
        if row is None:
            skipped.append({"file": img_path, "why": "no face detected"})
            protocol.log(f"warning: no usable face in {img_path}, skipped")
            continue
        try:
            emb = engine.embed(bgr, row)
        except Exception as exc:
            skipped.append({"file": img_path, "why": f"embedding failed: {exc}"})
            protocol.log(f"warning: embedding failed for {img_path}: {exc}")
            continue
        entries.append(
            {
                "file": os.path.basename(img_path),
                "embedding": [round(float(x), EMBEDDING_PRECISION) for x in emb],
            }
        )

    if not entries:
        raise ValueError(
            "no usable face found in any reference still — a character kit needs at "
            "least one clear, front-facing image"
        )

    reference = spherical_mean(np.array([e["embedding"] for e in entries], dtype=np.float64))
    kit = {
        "model": "sface-2021dec",
        "dim": len(entries[0]["embedding"]),
        "images": entries,
        "reference": [round(float(x), EMBEDDING_PRECISION) for x in reference],
    }
    if skipped:
        kit["skipped"] = skipped

    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(kit, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, out_path)

    return {
        "out": os.path.abspath(out_path),
        "embedded": len(entries),
        "skipped": len(skipped),
        "dim": kit["dim"],
    }
