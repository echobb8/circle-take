"""Identity — YuNet detection + SFace embeddings against a locked character kit.

Doctrine (RESEARCH-tech.md §Identity):

* SFace's ``feature()`` output is NOT normalized — L2-normalize before cosine.
* Gate on the **p10** of the per-sample cosine series, not the mean and not the
  median: a take that is right 90% of the time and someone else for the other
  10% is unusable, and the median hides exactly that.
* OpenCV's default 0.363 cosine threshold is far too permissive for continuity
  gating (measured: same identity under abuse >= 0.755, different person 0.198),
  so 0.363 is used only as the "reads as a different person" hard floor.
* No face is never a failure. Below 30% scoreable frames the verdict is 'skip'.

The pure math (normalization, p10, bands, clustering, drift) is separated from
the model calls so it can be unit-tested with synthetic embeddings.
"""

from __future__ import annotations

import json
import os
from typing import Any

import numpy as np

from .. import thresholds as T
from .. import protocol


# ---------------------------------------------------------------------------
# Pure math
# ---------------------------------------------------------------------------


def l2_normalize(vec: np.ndarray) -> np.ndarray:
    """L2-normalize a vector (or each row of a matrix). Zero vectors pass through.

    Mandatory before any cosine comparison: cv2.FaceRecognizerSF.feature()
    returns unnormalized 128-D features (RT §Identity).
    """
    a = np.asarray(vec, dtype=np.float64)
    if a.ndim == 1:
        n = float(np.linalg.norm(a))
        return a if n == 0 else a / n
    norms = np.linalg.norm(a, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return a / norms


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity of two vectors, normalizing defensively."""
    an, bn = l2_normalize(a), l2_normalize(b)
    return float(np.clip(np.dot(an, bn), -1.0, 1.0))


def spherical_mean(embeddings: np.ndarray) -> np.ndarray:
    """Reference embedding for a kit: L2-normalize each, average, re-normalize.

    On the unit sphere this is the direction minimizing mean squared chordal
    distance — the right centroid for cosine-space comparison.
    """
    a = l2_normalize(np.asarray(embeddings, dtype=np.float64))
    if a.ndim == 1:
        return a
    return l2_normalize(a.mean(axis=0))


def p10(values: np.ndarray) -> float:
    """10th percentile — the gating statistic (RT §Identity: p10, not median)."""
    v = np.asarray(values, dtype=np.float64)
    if v.size == 0:
        return 0.0
    return float(np.percentile(v, 10))


def worst_window_mean(values: np.ndarray, window: int = T.IDENTITY_WORST_WINDOW) -> float:
    """Lowest mean over any contiguous window — the sustained bad stretch."""
    v = np.asarray(values, dtype=np.float64)
    if v.size == 0:
        return 0.0
    w = max(1, min(int(window), v.size))
    kernel = np.ones(w) / w
    return float(np.convolve(v, kernel, mode="valid").min())


def rolling_median(values: np.ndarray, window: int = T.IDENTITY_ROLLING_WINDOW) -> np.ndarray:
    """Rolling median used by the drift test."""
    v = np.asarray(values, dtype=np.float64)
    w = max(1, min(int(window), v.size))
    if v.size == 0:
        return v
    return np.array([np.median(v[max(0, i - w + 1) : i + 1]) for i in range(v.size)])


def detect_drift(values: np.ndarray, window: int = T.IDENTITY_ROLLING_WINDOW) -> float:
    """Decline from the best to a LATER rolling-median value.

    Positive result = similarity fell over the take (identity drifts / morphs);
    only declines that happen after the peak count, so a bad first frame that
    recovers is not reported as drift.
    """
    v = np.asarray(values, dtype=np.float64)
    if v.size < window + 1:
        return 0.0
    rm = rolling_median(v, window)
    best = -np.inf
    max_decline = 0.0
    for x in rm:
        best = max(best, x)
        max_decline = max(max_decline, best - x)
    return float(max_decline)


def band_for(score: float) -> str:
    """Map a p10 cosine onto its verdict band (RT §Identity)."""
    if score < T.IDENTITY_HARD_FAIL:
        return "hard_fail"
    if score < T.IDENTITY_WARN:
        return "fail"
    if score < T.IDENTITY_PASS:
        return "warn"
    return "pass"


def cluster_embeddings(
    embeddings: np.ndarray, cut: float = T.IDENTITY_CLUSTER_COSINE_CUT
) -> list[list[int]]:
    """Simple agglomerative clustering with a cosine-similarity cut.

    Average linkage, merging the closest pair until no pair is above ``cut``.
    RT §Identity: multi-face scenes must be clustered so we score the character
    we care about rather than whichever face happens to be biggest.
    """
    a = l2_normalize(np.asarray(embeddings, dtype=np.float64))
    if a.ndim == 1:
        a = a[None, :]
    n = a.shape[0]
    if n == 0:
        return []
    clusters: list[list[int]] = [[i] for i in range(n)]
    sim = a @ a.T
    while len(clusters) > 1:
        best = (-np.inf, -1, -1)
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                block = sim[np.ix_(clusters[i], clusters[j])]
                avg = float(block.mean())
                if avg > best[0]:
                    best = (avg, i, j)
        if best[0] < cut:
            break
        _, i, j = best
        clusters[i] = clusters[i] + clusters[j]
        clusters.pop(j)
    return [sorted(c) for c in clusters]


def score_identity(
    similarities: np.ndarray,
    scoreable_fraction: float,
) -> tuple[str, int, dict[str, float]]:
    """Pure verdict/score/metrics from a cosine series. No model calls.

    Returns (verdict, score 0-100, metrics dict).
    """
    v = np.asarray(similarities, dtype=np.float64)
    if v.size == 0:
        return "skip", 100, {}
    metrics = {
        "median": float(np.median(v)),
        "p10": p10(v),
        "worstWindow": worst_window_mean(v),
        "min": float(v.min()),
        "max": float(v.max()),
        "drift": detect_drift(v),
        "scoreableFraction": float(scoreable_fraction),
    }
    gate = metrics["p10"]
    band = band_for(gate)
    if band in ("fail", "hard_fail"):
        verdict = "fail"
    elif band == "warn" or metrics["drift"] > T.IDENTITY_DRIFT_DELTA:
        verdict = "flag"
    else:
        verdict = "pass"

    # Map cosine onto 0-100 with the band edges as anchors, so a score reads
    # consistently against the thresholds the UI annotates.
    if gate >= T.IDENTITY_PASS:
        score = 85 + 15 * (gate - T.IDENTITY_PASS) / max(1e-6, 1.0 - T.IDENTITY_PASS)
    elif gate >= T.IDENTITY_WARN:
        score = 55 + 30 * (gate - T.IDENTITY_WARN) / max(1e-6, T.IDENTITY_PASS - T.IDENTITY_WARN)
    elif gate >= T.IDENTITY_HARD_FAIL:
        score = 20 + 35 * (gate - T.IDENTITY_HARD_FAIL) / max(
            1e-6, T.IDENTITY_WARN - T.IDENTITY_HARD_FAIL
        )
    else:
        score = 20 * max(0.0, gate) / max(1e-6, T.IDENTITY_HARD_FAIL)
    if verdict == "flag" and metrics["drift"] > T.IDENTITY_DRIFT_DELTA:
        score = min(score, 80)
    score = int(round(float(np.clip(score, 0, 100))))
    if verdict == "fail":
        score = min(score, T.OVERALL_FAIL_CAP)
    return verdict, score, metrics


# ---------------------------------------------------------------------------
# Kit I/O
# ---------------------------------------------------------------------------


def load_kit(path: str) -> dict[str, Any]:
    """Load a kit embeddings.json and return it with a validated reference vector."""
    with open(path, encoding="utf-8") as fh:
        kit = json.load(fh)
    images = kit.get("images") or []
    if not images and not kit.get("reference"):
        raise ValueError(f"kit {path} contains no embeddings")
    ref = kit.get("reference")
    if not ref:
        ref = spherical_mean(np.array([i["embedding"] for i in images], dtype=np.float64)).tolist()
        kit["reference"] = ref
    return kit


# ---------------------------------------------------------------------------
# Model wrappers
# ---------------------------------------------------------------------------


class FaceEngine:
    """YuNet detector + SFace recognizer, loaded once per run.

    CPU execution only — RT §Identity: CoreML is 3x SLOWER for models this small.
    """

    def __init__(self, yunet_path: str, sface_path: str) -> None:
        import cv2

        self.cv2 = cv2
        self.detector = cv2.FaceDetectorYN_create(
            yunet_path,
            "",
            (320, 320),
            T.YUNET_SCORE_THRESHOLD,
            T.YUNET_NMS_THRESHOLD,
            T.YUNET_TOP_K,
        )
        self.recognizer = cv2.FaceRecognizerSF_create(sface_path, "")

    def detect(self, bgr: np.ndarray) -> np.ndarray:
        """Return an (n, 15) float32 array of face rows; empty when none.

        The RAW row is what alignCrop needs (it carries the 5 landmarks) — never
        reconstruct a box and pass that instead.
        """
        h, w = bgr.shape[:2]
        self.detector.setInputSize((w, h))
        _rc, faces = self.detector.detect(bgr)
        if faces is None or len(faces) == 0:
            return np.zeros((0, 15), dtype=np.float32)
        return np.asarray(faces, dtype=np.float32)

    def embed(self, bgr: np.ndarray, face_row: np.ndarray) -> np.ndarray:
        """alignCrop → feature → L2-normalize."""
        aligned = self.recognizer.alignCrop(bgr, face_row.reshape(1, -1))
        feat = self.recognizer.feature(aligned)
        return l2_normalize(np.asarray(feat, dtype=np.float64).ravel())


def qualifying_faces(faces: np.ndarray, min_side: int = T.MIN_FACE_SIDE_PX) -> np.ndarray:
    """Filter detection rows to those big enough to embed reliably."""
    if faces.size == 0:
        return faces
    keep = (faces[:, 2] >= min_side) & (faces[:, 3] >= min_side)
    return faces[keep]


def largest_face(faces: np.ndarray) -> np.ndarray | None:
    """Row with the largest area, or None."""
    if faces.size == 0:
        return None
    areas = faces[:, 2] * faces[:, 3]
    return faces[int(np.argmax(areas))]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run(
    media_path: str,
    kit_path: str | None,
    cache_dir: str | None = None,
    sample_fps: float = T.DEFAULT_SAMPLE_FPS,
) -> dict[str, Any]:
    """Run the identity check against a character kit."""
    if not kit_path:
        return {
            "verdict": "skip",
            "score": 100,
            "reason": "no character kit supplied for this shot — identity not scored",
            "details": {},
            "evidence_frames": [],
        }
    if not os.path.isfile(kit_path):
        return {
            "verdict": "skip",
            "score": 100,
            "reason": f"character kit not found at {kit_path} — identity not scored",
            "details": {},
            "evidence_frames": [],
        }

    from ..models import SFACE, YUNET, ModelError, ensure_model
    from ..video import Clip, downscale_to_height, sample_stride

    try:
        kit = load_kit(kit_path)
    except (ValueError, KeyError, json.JSONDecodeError) as exc:
        return {
            "verdict": "skip",
            "score": 100,
            "reason": f"character kit could not be read ({exc}) — identity not scored",
            "details": {},
            "evidence_frames": [],
        }

    try:
        yunet_path = ensure_model(YUNET, cache_dir)
        sface_path = ensure_model(SFACE, cache_dir)
    except ModelError as exc:
        return {
            "verdict": "skip",
            "score": 100,
            "reason": f"face models unavailable — identity not scored ({exc})",
            "details": {},
            "evidence_frames": [],
        }

    engine = FaceEngine(yunet_path, sface_path)
    reference = l2_normalize(np.asarray(kit["reference"], dtype=np.float64))

    samples: list[dict[str, Any]] = []
    n_sampled = 0
    n_multiface = 0

    with Clip(media_path) as clip:
        stride = sample_stride(clip.fps, sample_fps)
        duration = clip.duration_sec
        head = duration * T.IDENTITY_HEAD_TAIL_SKIP
        tail = duration - head if duration > 0 else float("inf")
        for idx, t, frame in clip.frames(stride=stride):
            if duration > 0 and (t < head or t > tail):
                continue
            n_sampled += 1
            work = downscale_to_height(frame, T.METRIC_MAX_HEIGHT)
            faces = qualifying_faces(engine.detect(work))
            if faces.shape[0] == 0:
                continue
            if faces.shape[0] > 1:
                n_multiface += 1
            for row in faces:
                try:
                    emb = engine.embed(work, row)
                except Exception as exc:  # pragma: no cover - defensive
                    protocol.log(f"warning: embedding failed at frame {idx}: {exc}")
                    continue
                samples.append(
                    {
                        "frame": idx,
                        "t": t,
                        "embedding": emb,
                        "area": float(row[2] * row[3]),
                        "score": float(row[14]) if row.shape[0] > 14 else 1.0,
                    }
                )
        clip_fps = clip.fps

    if n_sampled == 0:
        return {
            "verdict": "skip",
            "score": 100,
            "reason": "no frames sampled — identity not scored",
            "details": {},
            "evidence_frames": [],
        }

    frames_with_face = len({s["frame"] for s in samples})
    scoreable_fraction = frames_with_face / n_sampled
    multiface_fraction = n_multiface / n_sampled

    if scoreable_fraction < T.IDENTITY_MIN_SCOREABLE_FRACTION:
        pct = round((1.0 - scoreable_fraction) * 100)
        return {
            "verdict": "skip",
            "score": 100,
            "reason": f"no scoreable face in {pct}% of frames — identity not scored",
            "details": {
                "sampledFrames": n_sampled,
                "framesWithFace": frames_with_face,
                "scoreableFraction": round(scoreable_fraction, 3),
            },
            "evidence_frames": [],
        }

    # Multi-face: cluster and score the cluster that best matches the kit.
    clustered = False
    chosen = samples
    n_clusters = 1
    if multiface_fraction >= T.IDENTITY_MULTIFACE_FRAME_FRACTION and len(samples) > 1:
        clustered = True
        embs = np.array([s["embedding"] for s in samples])
        clusters = cluster_embeddings(embs)
        n_clusters = len(clusters)
        best_idx, best_sim = None, -np.inf
        for c in clusters:
            centroid = spherical_mean(embs[c])
            sim = cosine(centroid, reference)
            if sim > best_sim:
                best_sim, best_idx = sim, c
        chosen = [samples[i] for i in (best_idx or [])]
    else:
        # Single-subject: one face per frame, the largest.
        by_frame: dict[int, dict[str, Any]] = {}
        for s in samples:
            cur = by_frame.get(s["frame"])
            if cur is None or s["area"] > cur["area"]:
                by_frame[s["frame"]] = s
        chosen = [by_frame[k] for k in sorted(by_frame)]

    chosen.sort(key=lambda s: s["frame"])
    sims = np.array([cosine(s["embedding"], reference) for s in chosen])
    verdict, score, metrics = score_identity(sims, scoreable_fraction)

    # -- reason ---------------------------------------------------------------
    band = band_for(metrics["p10"])
    parts: list[str] = []
    if band == "hard_fail":
        parts.append(
            f"reads as a different person (p10 similarity {metrics['p10']:.2f}, "
            f"below the {T.IDENTITY_HARD_FAIL:.2f} floor)"
        )
    elif band == "fail":
        parts.append(
            f"identity does not hold (p10 similarity {metrics['p10']:.2f} vs "
            f"{T.IDENTITY_WARN:.2f} minimum)"
        )
    elif band == "warn":
        parts.append(
            f"identity is marginal (p10 similarity {metrics['p10']:.2f}, median "
            f"{metrics['median']:.2f}; {T.IDENTITY_PASS:.2f} needed for a clean pass)"
        )
    else:
        parts.append(
            f"identity holds (p10 {metrics['p10']:.2f}, median {metrics['median']:.2f})"
        )
    if metrics["drift"] > T.IDENTITY_DRIFT_DELTA:
        worst_i = int(np.argmin(sims))
        parts.append(
            f"identity drifts over the take (similarity falls {metrics['drift']:.2f}, "
            f"worst at {chosen[worst_i]['t']:.1f}s)"
        )
    if metrics["worstWindow"] < T.IDENTITY_WARN:
        parts.append(f"sustained low-similarity window (mean {metrics['worstWindow']:.2f})")
    if clustered:
        parts.append(
            f"{n_clusters} distinct faces in shot — scored the cluster matching the kit"
        )
    if scoreable_fraction < 0.8:
        parts.append(f"face visible in {round(scoreable_fraction * 100)}% of sampled frames")
    reason = "; ".join(parts)

    # -- evidence: worst frames ----------------------------------------------
    order = np.argsort(sims)
    n_ev = T.MIN_EVIDENCE_FRAMES if verdict != "pass" else 1
    n_ev = min(max(n_ev, T.MIN_EVIDENCE_FRAMES if verdict != "pass" else 1), T.MAX_EVIDENCE_FRAMES, sims.size)
    evidence_frames = [
        {
            "frame": int(chosen[i]["frame"]),
            "t": round(float(chosen[i]["t"]), 3),
            "caption": f"lowest identity match (cosine {float(sims[i]):.2f})",
        }
        for i in order[:n_ev]
    ]

    series = [
        {"t": round(float(s["t"]), 3), "v": round(float(v), 4)} for s, v in zip(chosen, sims)
    ]

    return {
        "verdict": verdict,
        "score": score,
        "reason": reason,
        "series": series,
        "threshold": T.IDENTITY_PASS,
        "evidence_frames": evidence_frames,
        "details": {
            "kit": os.path.basename(kit_path),
            "kitModel": kit.get("model", "sface-2021dec"),
            "kitImages": len(kit.get("images") or []),
            "sampledFrames": n_sampled,
            "framesWithFace": frames_with_face,
            "scoreableFraction": round(scoreable_fraction, 3),
            "multiFaceFraction": round(multiface_fraction, 3),
            "clustered": clustered,
            "clusters": n_clusters,
            "medianCosine": round(metrics["median"], 4),
            "p10Cosine": round(metrics["p10"], 4),
            "worstWindowCosine": round(metrics["worstWindow"], 4),
            "drift": round(metrics["drift"], 4),
            "sampleFps": sample_fps,
            "fps": round(clip_fps, 3),
        },
    }
