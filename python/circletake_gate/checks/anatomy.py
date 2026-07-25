"""Anatomy — MediaPipe HandLandmarker, Tasks API only.

Hard constraints (RESEARCH-tech.md §Anatomy + RESEARCH-anatomy-supplement.md):

* ``mediapipe.tasks.python.vision.HandLandmarker`` ONLY. The legacy
  ``mp.solutions`` API does not exist in 0.10.35 — it was removed, not
  deprecated.
* NO FINGER COUNTING. The model emits a fixed 21x3 tensor, so a sixth finger is
  architecturally unrepresentable; a extra digit moves the handedness score by
  only ~0.04. Dropout + bone geometry + planarity + ROM is the gate.
* Hand landmarks carry NO visibility/presence (both are None). Only the
  handedness score and the dropout rate are usable confidence signals.
* Nearest-wrist association across frames MUST happen before any temporal
  metric — MediaPipe does not keep hand ordering stable, and unassociated
  series produce spurious handedness flips and garbage jitter (measured).
* Jitter is ACCELERATION on WORLD landmarks normalized by palm scale (76x
  discriminator; velocity is only 7x).
* A fresh landmarker is created per clip: ``detect_for_video`` requires
  monotonically increasing timestamps for the landmarker's entire lifetime.

Every MediaPipe touch is wrapped: any ImportError/RuntimeError degrades the check
to verdict 'skip' with a reason. Anatomy never takes a gate run down (the
Windows AttributeError risk, upstream mediapipe#6187).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .. import thresholds as T
from .. import protocol

WRIST = 0
MIDDLE_MCP = 9

#: (MCP, PIP, DIP, TIP) for index, middle, ring, little. The thumb is excluded:
#: its saddle joint makes the planarity assumption invalid.
FINGER_CHAINS = ((5, 6, 7, 8), (9, 10, 11, 12), (13, 14, 15, 16), (17, 18, 19, 20))


# ---------------------------------------------------------------------------
# Pure geometry (unit-tested with synthetic landmark arrays — no model needed)
# ---------------------------------------------------------------------------


def palm_scale(world: np.ndarray) -> float:
    """||W0 - W9||, the palm-length normalizer for every other metric (RAS §4)."""
    w = np.asarray(world, dtype=np.float64)
    return float(np.linalg.norm(w[WRIST] - w[MIDDLE_MCP]))


def bone_lengths(world: np.ndarray) -> np.ndarray:
    """The 23 template bone lengths of one hand, in BONE_EDGES order."""
    w = np.asarray(world, dtype=np.float64)
    return np.array([np.linalg.norm(w[a] - w[b]) for a, b in T.BONE_EDGES])


def bone_log_ratio(world: np.ndarray) -> tuple[float, float]:
    """BLR = mean|log(r_i / canon_i)| and its max, on WORLD landmarks (RAS §6).

    r_i = bone_i / palm_scale. Returns (mean, max); (inf, inf) for a degenerate
    hand so the caller's thresholds treat it as broken rather than perfect.
    """
    scale = palm_scale(world)
    if scale <= 0:
        return math.inf, math.inf
    r = bone_lengths(world) / scale
    canon = np.array(T.BONE_TEMPLATE, dtype=np.float64)
    valid = (r > 0) & (canon > 0)
    if not valid.any():
        return math.inf, math.inf
    dev = np.abs(np.log(r[valid] / canon[valid]))
    return float(dev.mean()), float(dev.max())


def finger_planarity(world: np.ndarray) -> list[float]:
    """s3/s1 of the centered SVD of each finger's 4 world points (RAS §7).

    Real fingers are near-planar (measured 0.002-0.034); a generated hand bends
    its joints out of plane.
    """
    w = np.asarray(world, dtype=np.float64)
    out: list[float] = []
    for chain in FINGER_CHAINS:
        pts = w[list(chain)]
        pts = pts - pts.mean(axis=0)
        try:
            s = np.linalg.svd(pts, compute_uv=False)
        except np.linalg.LinAlgError:  # pragma: no cover - defensive
            continue
        if s.size < 3 or s[0] <= 0:
            continue
        out.append(float(s[2] / s[0]))
    return out


def _angle_between(v1: np.ndarray, v2: np.ndarray) -> float:
    n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
    if n1 == 0 or n2 == 0:
        return 0.0
    return float(np.degrees(np.arccos(np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0))))


def joint_angles(world: np.ndarray) -> dict[str, list[float]]:
    """Per-joint flexion angles in degrees, grouped by joint class (RAS §8).

    Flexion is the deviation from straight (0 deg = fully extended). The
    DIP ~= (2/3)*PIP coupling heuristic is deliberately NOT computed — it is a
    measured false-positive generator on MediaPipe's z-depth.
    """
    w = np.asarray(world, dtype=np.float64)
    out: dict[str, list[float]] = {"mcp_flex": [], "pip_flex": [], "dip_flex": [], "mcp_abduction": []}
    palm_normal = None
    try:
        v1 = w[5] - w[WRIST]
        v2 = w[17] - w[WRIST]
        n = np.cross(v1, v2)
        if np.linalg.norm(n) > 0:
            palm_normal = n / np.linalg.norm(n)
    except Exception:  # pragma: no cover - defensive
        palm_normal = None

    for mcp, pip, dip, tip in FINGER_CHAINS:
        out["mcp_flex"].append(_angle_between(w[mcp] - w[WRIST], w[pip] - w[mcp]))
        out["pip_flex"].append(_angle_between(w[pip] - w[mcp], w[dip] - w[pip]))
        out["dip_flex"].append(_angle_between(w[dip] - w[pip], w[tip] - w[dip]))
        if palm_normal is not None:
            # Abduction = in-plane sideways splay of the proximal phalanx.
            bone = w[pip] - w[mcp]
            ref = w[MIDDLE_MCP] - w[WRIST]
            bone_p = bone - np.dot(bone, palm_normal) * palm_normal
            ref_p = ref - np.dot(ref, palm_normal) * palm_normal
            ang = _angle_between(bone_p, ref_p)
            out["mcp_abduction"].append(ang)
    return out


def rom_violations(world: np.ndarray) -> int:
    """Count joints outside their physiological range (RAS §8 hard gates)."""
    angles = joint_angles(world)
    n = 0
    for key, values in angles.items():
        lo, hi = T.JOINT_ROM_DEG.get(key, T.JOINT_ANGLE_RANGE_DEG)
        for a in values:
            if a < lo or a > hi:
                n += 1
    return n


def acceleration_series(world_seq: list[np.ndarray]) -> np.ndarray:
    """Per-frame mean landmark ACCELERATION, palm-scale normalized (RAS §4).

    a(t) = mean_i ||P_i(t) - 2*P_i(t-1) + P_i(t-2)|| / palm_scale(t).
    Acceleration — not velocity — is the discriminator (76x vs 7x separation).
    """
    if len(world_seq) < 3:
        return np.zeros(0)
    out: list[float] = []
    for i in range(2, len(world_seq)):
        p0, p1, p2 = world_seq[i - 2], world_seq[i - 1], world_seq[i]
        scale = palm_scale(p2)
        if scale <= 0:
            continue
        accel = np.linalg.norm(p2 - 2.0 * p1 + p0, axis=1) / scale
        out.append(float(np.mean(accel)))
    return np.array(out)


def bone_length_cv(world_seq: list[np.ndarray]) -> float:
    """Coefficient of variation of palm-normalized bone lengths OVER TIME.

    Real hands are rigid, so this should be near zero regardless of pose. Kept as
    a primary signal per RAS §6 alongside the static template comparison.
    """
    rows: list[np.ndarray] = []
    for w in world_seq:
        scale = palm_scale(w)
        if scale <= 0:
            continue
        rows.append(bone_lengths(w) / scale)
    if len(rows) < 2:
        return 0.0
    m = np.vstack(rows)
    means = m.mean(axis=0)
    valid = means > 1e-9
    if not valid.any():
        return 0.0
    return float(np.mean(m[:, valid].std(axis=0) / means[valid]))


def associate_by_wrist(
    tracks: list[dict[str, Any]],
    detections: list[dict[str, Any]],
    max_dist: float = T.HAND_ASSOCIATION_MAX_DIST,
) -> list[int | None]:
    """Greedy nearest-wrist association of detections to existing tracks (RAS §3).

    Returns, per detection, the index of the track it belongs to (or None for a
    new track). Wrist positions are normalized image coordinates, so ``max_dist``
    is a fraction of the frame.

    Without this step MediaPipe's unstable per-frame hand ordering produces
    spurious handedness flips and meaningless jitter series.
    """
    assignments: list[int | None] = [None] * len(detections)
    if not tracks or not detections:
        return assignments
    pairs: list[tuple[float, int, int]] = []
    for di, det in enumerate(detections):
        for ti, tr in enumerate(tracks):
            d = float(np.linalg.norm(np.asarray(det["wrist"]) - np.asarray(tr["wrist"])))
            if d <= max_dist:
                pairs.append((d, di, ti))
    pairs.sort()
    used_d: set[int] = set()
    used_t: set[int] = set()
    for _d, di, ti in pairs:
        if di in used_d or ti in used_t:
            continue
        assignments[di] = ti
        used_d.add(di)
        used_t.add(ti)
    return assignments


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _skip(
    reason: str, details: dict[str, Any] | None = None, mediapipe_ok: bool = False
) -> dict[str, Any]:
    """Skip result.

    ``mediapipe_ok`` records whether MediaPipe actually loaded and ran. It
    distinguishes "the runtime is missing" from "the runtime worked and there
    were simply no hands in the shot" — the report's modelVersions must not
    claim 'unavailable' for a model that ran perfectly well.
    """
    return {
        "verdict": "skip",
        "score": 100,
        "reason": reason,
        "details": {**(details or {}), "mediapipeAvailable": mediapipe_ok},
        "evidence_frames": [],
    }


def run(
    media_path: str,
    cache_dir: str | None = None,
    sample_fps: float = T.DEFAULT_SAMPLE_FPS,
) -> dict[str, Any]:
    """Run the anatomy check, degrading to 'skip' on any MediaPipe problem."""
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python import vision as mp_vision
    except (ImportError, RuntimeError, AttributeError) as exc:
        return _skip(f"MediaPipe unavailable on this platform — anatomy not scored ({exc})")

    from ..models import HAND_LANDMARKER, ensure_rolling_model

    model_path, warning = ensure_rolling_model(HAND_LANDMARKER, cache_dir)
    if model_path is None:
        return _skip(f"hand landmark model unavailable — anatomy not scored ({warning})")

    from ..video import Clip, downscale_to_height, sample_stride

    landmarker = None
    try:
        options = mp_vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            running_mode=mp_vision.RunningMode.VIDEO,
            num_hands=T.HAND_MAX_HANDS,
            min_hand_detection_confidence=T.HAND_DETECTION_CONFIDENCE,
            min_hand_presence_confidence=T.HAND_PRESENCE_CONFIDENCE,
            min_tracking_confidence=T.HAND_TRACKING_CONFIDENCE,
        )
        # Fresh landmarker per clip: detect_for_video demands monotonically
        # increasing timestamps for the object's whole lifetime (RAS §2).
        landmarker = mp_vision.HandLandmarker.create_from_options(options)
    except (RuntimeError, ValueError, AttributeError, OSError) as exc:
        return _skip(f"hand landmarker failed to initialize — anatomy not scored ({exc})")

    # tracks[i] = {'wrist': (x,y), 'world': [...], 'handedness': [...], 'frames': [...]}
    tracks: list[dict[str, Any]] = []
    n_sampled = 0
    n_with_hands = 0
    frame_records: list[dict[str, Any]] = []

    try:
        with Clip(media_path) as clip:
            stride = sample_stride(clip.fps, sample_fps)
            clip_fps = clip.fps
            ts_ms = 0
            for idx, t, frame in clip.frames(stride=stride):
                n_sampled += 1
                work = downscale_to_height(frame, T.METRIC_MAX_HEIGHT)
                rgb = work[:, :, ::-1].copy()
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                # Timestamps must strictly increase; derive from the frame time
                # but never repeat a value.
                ts_ms = max(ts_ms + 1, int(round(t * 1000.0)))
                try:
                    result = landmarker.detect_for_video(image, ts_ms)
                except (RuntimeError, ValueError) as exc:
                    protocol.log(f"warning: hand detection failed at frame {idx}: {exc}")
                    continue

                dets: list[dict[str, Any]] = []
                hand_world = getattr(result, "hand_world_landmarks", None) or []
                hand_lms = getattr(result, "hand_landmarks", None) or []
                handedness = getattr(result, "handedness", None) or []
                for hi in range(len(hand_world)):
                    try:
                        world = np.array(
                            [[lm.x, lm.y, lm.z] for lm in hand_world[hi]], dtype=np.float64
                        )
                        img_lms = hand_lms[hi] if hi < len(hand_lms) else None
                        wrist_xy = (
                            (img_lms[WRIST].x, img_lms[WRIST].y) if img_lms else (0.5, 0.5)
                        )
                        cat = handedness[hi][0] if hi < len(handedness) and handedness[hi] else None
                        dets.append(
                            {
                                "world": world,
                                "wrist": wrist_xy,
                                "label": getattr(cat, "category_name", "?") if cat else "?",
                                # Hand landmarks have NO visibility/presence
                                # (RAS §5) — the handedness score is the only
                                # per-detection confidence available.
                                "score": float(getattr(cat, "score", 0.0)) if cat else 0.0,
                            }
                        )
                    except (AttributeError, IndexError, ValueError) as exc:
                        protocol.log(f"warning: malformed landmark result at {idx}: {exc}")

                if dets:
                    n_with_hands += 1

                assignments = associate_by_wrist(tracks, dets)
                for di, det in enumerate(dets):
                    ti = assignments[di]
                    if ti is None:
                        tracks.append(
                            {
                                "wrist": det["wrist"],
                                "world": [det["world"]],
                                "labels": [det["label"]],
                                "scores": [det["score"]],
                                "frames": [idx],
                                "times": [t],
                            }
                        )
                    else:
                        tr = tracks[ti]
                        tr["wrist"] = det["wrist"]
                        tr["world"].append(det["world"])
                        tr["labels"].append(det["label"])
                        tr["scores"].append(det["score"])
                        tr["frames"].append(idx)
                        tr["times"].append(t)

                frame_records.append({"frame": idx, "t": t, "hands": len(dets)})
    except Exception as exc:
        return _skip(f"anatomy pass failed — not scored ({exc})", mediapipe_ok=True)
    finally:
        try:
            if landmarker is not None:
                landmarker.close()
        except Exception:  # pragma: no cover - defensive
            pass

    if n_sampled == 0:
        return _skip("no frames sampled — anatomy not scored", mediapipe_ok=True)

    hand_fraction = n_with_hands / n_sampled
    if hand_fraction < T.HAND_MIN_FRAME_FRACTION:
        return _skip(
            "no hands in frame — anatomy not scored",
            {
                "sampledFrames": n_sampled,
                "framesWithHands": n_with_hands,
                "handFraction": round(hand_fraction, 3),
            },
            mediapipe_ok=True,
        )

    # Longest track = the hand actually carrying the performance.
    tracks = [t for t in tracks if len(t["world"]) >= 1]
    tracks.sort(key=lambda tr: -len(tr["world"]))
    main = tracks[0]
    world_seq: list[np.ndarray] = main["world"]

    # -- dropout: gaps in a track while hands are otherwise present ----------
    first, last = main["frames"][0], main["frames"][-1]
    span_frames = [r for r in frame_records if first <= r["frame"] <= last]
    expected = len(span_frames)
    observed = len(main["frames"])
    dropout = 1.0 - (observed / expected) if expected else 0.0

    # -- static geometry, per frame ------------------------------------------
    blr_means: list[float] = []
    blr_maxes: list[float] = []
    planarities: list[float] = []
    rom_bad: list[int] = []
    for w in world_seq:
        m, mx = bone_log_ratio(w)
        if math.isfinite(m):
            blr_means.append(m)
            blr_maxes.append(mx)
        pl = finger_planarity(w)
        if pl:
            planarities.append(float(np.median(pl)))
        rom_bad.append(rom_violations(w))

    accel = acceleration_series(world_seq)
    cv = bone_length_cv(world_seq)
    scores = np.array(main["scores"], dtype=np.float64)
    labels = main["labels"]
    flips = sum(1 for a, b in zip(labels, labels[1:]) if a != b and "?" not in (a, b))

    med_blr = float(np.median(blr_means)) if blr_means else 0.0
    max_blr = float(np.max(blr_maxes)) if blr_maxes else 0.0
    med_planarity = float(np.median(planarities)) if planarities else 0.0
    med_accel = float(np.median(accel)) if accel.size else 0.0
    mean_hand_score = float(scores.mean()) if scores.size else 0.0
    rom_fraction = float(np.mean(np.array(rom_bad) > 0)) if rom_bad else 0.0

    # Self-calibration against the clip's own median (RT §Anatomy): a spike only
    # counts if it also stands out from this clip's baseline.
    accel_p95 = float(np.percentile(accel, 95)) if accel.size else 0.0
    accel_spikes = (
        int((accel > max(T.JITTER_ACCEL_SUSPICIOUS, med_accel * T.ANATOMY_SELF_CAL_MULTIPLE)).sum())
        if accel.size
        else 0
    )

    # -- verdict --------------------------------------------------------------
    findings: list[str] = []
    severity = 0

    if dropout > T.HAND_DROPOUT_FAIL:
        severity += 2
        findings.append(f"hand tracking drops out in {round(dropout * 100)}% of frames where it should persist")
    elif dropout > T.HAND_DROPOUT_FLAG:
        severity += 1
        findings.append(f"intermittent hand tracking ({round(dropout * 100)}% dropout)")

    if med_blr > T.BONE_LOG_RATIO_FAIL:
        severity += 2
        findings.append(f"bone proportions are anatomically wrong (log-ratio error {med_blr:.2f})")
    elif med_blr > T.BONE_LOG_RATIO_WARN:
        severity += 1
        findings.append(f"bone proportions off-template (log-ratio error {med_blr:.2f})")
    elif max_blr > T.BONE_LOG_RATIO_MAX_WARN:
        severity += 1
        findings.append(f"one bone badly off-template (log-ratio {max_blr:.2f})")

    if cv > T.BONE_LENGTH_CV_FAIL:
        severity += 2
        findings.append(f"bone lengths change shot-to-shot within the take (variance {cv:.2f})")
    elif cv > T.BONE_LENGTH_CV_FLAG:
        severity += 1
        findings.append(f"bone lengths are not rigid over time (variance {cv:.2f})")

    if med_planarity > T.PLANARITY_FAIL:
        severity += 2
        findings.append(f"fingers bend out of plane (planarity {med_planarity:.3f})")
    elif med_planarity > T.PLANARITY_WARN:
        severity += 1
        findings.append(f"finger planarity is marginal ({med_planarity:.3f})")

    if med_accel > T.JITTER_ACCEL_STRONG:
        severity += 2
        findings.append(f"landmarks jitter heavily (median acceleration {med_accel:.3f})")
    elif med_accel > T.JITTER_ACCEL_SUSPICIOUS:
        severity += 1
        findings.append(f"landmark jitter above the model floor (median acceleration {med_accel:.3f})")

    if rom_fraction > T.HYPEREXTENSION_FRAME_FLAG:
        severity += 1
        findings.append(
            f"joints hyperextend beyond the physiological range in "
            f"{round(rom_fraction * 100)}% of hand frames"
        )

    if flips >= T.HANDEDNESS_FLIP_FAIL:
        severity += 2
        findings.append(f"the tracked hand changes handedness {flips} times")
    elif flips >= T.HANDEDNESS_FLIP_FLAG:
        severity += 1
        findings.append(f"handedness flips {flips}x on the tracked hand")

    if mean_hand_score < T.HANDEDNESS_SCORE_FAIL:
        severity += 1
        findings.append(f"hand detections are low confidence (mean {mean_hand_score:.2f})")
    elif mean_hand_score < T.HANDEDNESS_SCORE_WARN:
        findings.append(f"hand confidence is soft (mean {mean_hand_score:.2f})")

    # Deliberately conservative: this check flags. It fails only when tracking
    # collapses AND geometry is extreme at the same time.
    egregious = dropout > T.HAND_DROPOUT_EGREGIOUS and (
        cv > T.BONE_LENGTH_CV_FAIL or med_blr > T.BONE_LOG_RATIO_FAIL
    )
    if egregious:
        verdict = "fail"
    elif findings:
        verdict = "flag"
    else:
        verdict = "pass"

    score = int(round(max(0.0, 100.0 - 11.0 * severity)))
    if verdict == "fail":
        score = min(score, T.OVERALL_FAIL_CAP)

    if findings:
        reason = "; ".join(findings[:4])
    else:
        reason = (
            f"hands are anatomically consistent across {observed} frames "
            f"(bone-length error {med_blr:.2f}, acceleration {med_accel:.3f}, "
            f"{round(dropout * 100)}% dropout)"
        )

    # -- evidence -------------------------------------------------------------
    evidence_frames: list[dict[str, Any]] = []
    if accel.size and verdict != "pass":
        order = np.argsort(accel)[::-1][: T.MIN_EVIDENCE_FRAMES]
        for i in order:
            fi = i + 2  # acceleration index i corresponds to world_seq[i+2]
            if fi < len(main["frames"]):
                evidence_frames.append(
                    {
                        "frame": int(main["frames"][fi]),
                        "t": round(float(main["times"][fi]), 3),
                        "caption": f"hand instability (acceleration {float(accel[i]):.3f})",
                    }
                )
    if not evidence_frames and main["frames"]:
        evidence_frames.append(
            {
                "frame": int(main["frames"][len(main["frames"]) // 2]),
                "t": round(float(main["times"][len(main["times"]) // 2]), 3),
                "caption": f"tracked hand (bone-length error {med_blr:.2f})",
            }
        )

    series = [
        {"t": round(float(main["times"][i + 2]), 3), "v": round(float(a), 5)}
        for i, a in enumerate(accel)
        if i + 2 < len(main["times"])
    ]

    details: dict[str, Any] = {
        "sampledFrames": n_sampled,
        "framesWithHands": n_with_hands,
        "handFraction": round(hand_fraction, 3),
        "tracks": len(tracks),
        "trackedFrames": observed,
        "dropoutRate": round(dropout, 3),
        "boneLogRatioMedian": round(med_blr, 4),
        "boneLogRatioMax": round(max_blr, 4),
        "boneLengthCv": round(cv, 4),
        "planarityMedian": round(med_planarity, 4),
        "accelMedian": round(med_accel, 5),
        "accelP95": round(accel_p95, 5),
        "accelSpikes": accel_spikes,
        "handednessFlips": int(flips),
        "handednessScoreMean": round(mean_hand_score, 3),
        "romViolationFraction": round(rom_fraction, 3),
        "sampleFps": sample_fps,
        "fps": round(clip_fps, 3),
        "modelWarning": warning,
        "mediapipeAvailable": True,
    }

    return {
        "verdict": verdict,
        "score": score,
        "reason": reason,
        "series": series,
        "threshold": T.JITTER_ACCEL_SUSPICIOUS,
        "evidence_frames": evidence_frames,
        "details": details,
    }
