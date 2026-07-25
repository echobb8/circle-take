"""Temporal integrity — the core check.

Measures, per consecutive frame pair at a fixed 480 px working width:

* ``naive_diff``  — mean |cur - prev|, the raw change a viewer sees;
* ``warp_err``    — the change that survives motion compensation (DIS flow,
  remap, Sundaram forward-backward consistency mask);
* ``ratio``       — warp_err / naive_diff, THE discriminator.

The ratio is what separates an AI artifact from a camera move. A clean pan has a
large naive_diff that flow explains almost entirely (ratio ~0.21). Generative
churn produces change that no motion field can explain (ratio ~0.92). A geometric
jump is explainable but discontinuous (ratio ~0.06 plus a flow-magnitude spike).

On top of that: a luma-flicker detector (robust MAD on the second difference,
gated by FFT periodicity so legitimate exposure changes do not fire), a
scenedetect discontinuity cross-check, and a VBench dynamic-degree port that
catches a generation that simply froze.

References: RESEARCH-tech.md §Temporal, RESEARCH-temporal-supplement.md §1-5.
"""

from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np

from .. import thresholds as T
from .. import protocol
from ..video import Clip, downscale_to_width, temporal_stride, to_gray


# ---------------------------------------------------------------------------
# Flow primitives
# ---------------------------------------------------------------------------


def _make_dis() -> Any:
    """DIS optical flow, PRESET_FAST (RT §Temporal: Farneback under-estimates by
    3x at 1080p and is 36x slower)."""
    return cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_FAST)


def _grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return gx, gy


def fb_consistency_mask(
    flow_fwd: np.ndarray, flow_bwd: np.ndarray
) -> tuple[np.ndarray, float]:
    """Sundaram/Brox forward-backward consistency mask (RTS §1).

    A pixel is valid iff ``|w + w_hat(x+w)|^2 < a*(|w|^2 + |w_hat|^2) + b`` and
    its forward correspondence lands inside the frame. Returns (bool mask,
    valid_fraction).
    """
    h, w = flow_fwd.shape[:2]
    gx, gy = _grid(h, w)
    map_x = gx + flow_fwd[..., 0]
    map_y = gy + flow_fwd[..., 1]

    # Sample the backward field at the forward correspondence.
    bwd_at = cv2.remap(
        flow_bwd, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
    )
    summed = flow_fwd + bwd_at
    lhs = summed[..., 0] ** 2 + summed[..., 1] ** 2
    mag_f = flow_fwd[..., 0] ** 2 + flow_fwd[..., 1] ** 2
    mag_b = bwd_at[..., 0] ** 2 + bwd_at[..., 1] ** 2
    consistent = lhs < (T.FB_CONSISTENCY_ALPHA * (mag_f + mag_b) + T.FB_CONSISTENCY_BETA)

    in_frame = (map_x >= 0) & (map_x <= w - 1) & (map_y >= 0) & (map_y <= h - 1)
    mask = consistent & in_frame
    return mask, float(mask.mean())


def warp_error(
    prev_gray: np.ndarray, cur_gray: np.ndarray, flow_fwd: np.ndarray, mask: np.ndarray
) -> float:
    """Mean |remap(cur, x + flow) - prev| over the valid region, 0-255.

    BORDER_REPLICATE keeps the edges finite; the mask (not the border mode) is
    what actually removes untrustworthy samples.
    """
    h, w = prev_gray.shape[:2]
    gx, gy = _grid(h, w)
    warped = cv2.remap(
        cur_gray,
        gx + flow_fwd[..., 0],
        gy + flow_fwd[..., 1],
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    diff = np.abs(warped - prev_gray)
    if not mask.any():
        return float(diff.mean())
    return float(diff[mask].mean())


def flow_magnitude_topk(flow: np.ndarray, top_fraction: float) -> float:
    """Mean magnitude of the largest ``top_fraction`` of flow vectors (RTS §4).

    Whole-frame means are dominated by static background, so VBench's
    dynamic-degree measures the moving tail instead.
    """
    mag = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2).ravel()
    if mag.size == 0:
        return 0.0
    k = max(1, int(round(mag.size * top_fraction)))
    idx = np.argpartition(mag, -k)[-k:]
    return float(mag[idx].mean())


# ---------------------------------------------------------------------------
# Pure signal helpers (unit-tested without any video)
# ---------------------------------------------------------------------------


def highpass_2nd_diff(series: np.ndarray) -> np.ndarray:
    """Apply the k=[-0.5, 1, -0.5] second-difference high-pass (RT §Temporal).

    Returns an array the same length as the input, zero-padded at both ends so
    indices line up with sample indices.
    """
    s = np.asarray(series, dtype=np.float64)
    out = np.zeros_like(s)
    if s.size < 3:
        return out
    out[1:-1] = -0.5 * s[:-2] + 1.0 * s[1:-1] - 0.5 * s[2:]
    return out


def mad_threshold(values: np.ndarray, k: float = T.FLICKER_MAD_K) -> float:
    """Robust outlier threshold: ``k * 1.4826 * MAD`` about the median."""
    v = np.asarray(values, dtype=np.float64)
    v = v[np.isfinite(v)]
    if v.size == 0:
        return math.inf
    med = float(np.median(v))
    mad = float(np.median(np.abs(v - med)))
    if mad <= 0:
        # Degenerate (perfectly flat) series: fall back to std so a single spike
        # in an otherwise constant signal is still detectable.
        sd = float(np.std(v))
        if sd <= 0:
            return math.inf
        return k * sd
    return k * T.MAD_TO_SIGMA * mad


def periodicity_par(luma: np.ndarray, sample_fps: float) -> tuple[float, float]:
    """Peak-to-average power ratio of the normalized luma series (RTS §3).

    Detrends, applies a Hann window, and takes the FFT power spectrum. Returns
    ``(par, peak_hz)`` computed over f >= FLICKER_FREQ_MIN_HZ. Genuine flicker is
    narrowband (high PAR, peak in 1-15 Hz); legitimate exposure change is
    broadband and low-frequency.
    """
    s = np.asarray(luma, dtype=np.float64)
    s = s[np.isfinite(s)]
    n = s.size
    if n < 8 or sample_fps <= 0:
        return 0.0, 0.0
    mean = float(s.mean())
    if mean <= 0:
        return 0.0, 0.0
    s = s / mean
    # Linear detrend removes ramps (a legitimate exposure ramp is not flicker).
    x = np.arange(n, dtype=np.float64)
    coeffs = np.polyfit(x, s, 1)
    s = s - np.polyval(coeffs, x)
    s = s * np.hanning(n)

    power = np.abs(np.fft.rfft(s)) ** 2
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_fps)
    band = freqs >= T.FLICKER_FREQ_MIN_HZ
    if not band.any():
        return 0.0, 0.0
    pb = power[band]
    fb = freqs[band]
    mean_p = float(pb.mean())
    if mean_p <= 0:
        return 0.0, 0.0
    i = int(np.argmax(pb))
    return float(pb[i] / mean_p), float(fb[i])


def contiguous_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[(start, end_inclusive)] index runs of True in a boolean array."""
    m = np.asarray(mask, dtype=bool)
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for i, val in enumerate(m):
        if val and start is None:
            start = i
        elif not val and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, m.size - 1))
    return runs


def hysteresis_runs(
    values: np.ndarray, enter: float, extend: float, gate: np.ndarray | None = None
) -> list[tuple[int, int]]:
    """Two-threshold (hysteresis) run detection.

    A run must contain at least one sample at or above ``enter``, and spans every
    contiguous neighbour at or above ``extend``. Single-threshold detection
    shatters a real sustained event into fragments whenever the signal oscillates
    across the line — which is exactly what generative churn does.

    ``gate`` optionally masks samples that are ineligible regardless of value
    (e.g. untrustworthy warp measurements).
    """
    v = np.asarray(values, dtype=np.float64)
    if v.size == 0:
        return []
    eligible = np.ones(v.size, dtype=bool) if gate is None else np.asarray(gate, dtype=bool)
    extended = (v >= extend) & eligible
    runs: list[tuple[int, int]] = []
    for s, e in contiguous_runs(extended):
        if bool((v[s : e + 1] >= enter).any()):
            runs.append((s, e))
    return runs


def dynamic_degree(top_mags: np.ndarray, min_side: int) -> tuple[bool, float, int]:
    """VBench dynamic-degree port, resolution-normalized (RTS §4).

    Returns ``(is_moving, threshold, n_exceeding)``. A clip is moving iff at
    least round(4*T/16) of its T pairs exceed 6.0*min(H,W)/256.
    """
    mags = np.asarray(top_mags, dtype=np.float64)
    thres = T.DYNAMIC_FLOW_COEF * min_side / 256.0
    n_exceed = int((mags > thres).sum())
    needed = max(1, int(round(T.DYNAMIC_MIN_PAIR_FRACTION * mags.size)))
    return n_exceed >= needed, float(thres), n_exceed


def static_flicker_score(mae_values: np.ndarray) -> float:
    """VBench temporal-flickering score over static segments: ``1 - meanMAE/255``
    (RTS §4). Published bands: pass >= 0.990, warn 0.980-0.990, fail < 0.980."""
    v = np.asarray(mae_values, dtype=np.float64)
    if v.size == 0:
        return 1.0
    return float(1.0 - v.mean() / 255.0)


# ---------------------------------------------------------------------------
# Discontinuity candidates
# ---------------------------------------------------------------------------


def scene_cut_frames(media_path: str) -> list[int]:
    """AdaptiveDetector candidate cut frames (RT §Temporal params).

    Candidates only — every one is cross-checked against the flow ratio before it
    can become an event. Any scenedetect failure degrades to "no candidates"
    rather than taking the check down.
    """
    try:
        from scenedetect import AdaptiveDetector, SceneManager, open_video
    except ImportError as exc:  # pragma: no cover - dependency pinned
        protocol.log(f"warning: scenedetect unavailable ({exc}); skipping cut candidates")
        return []
    try:
        video = open_video(media_path)
        manager = SceneManager()
        # auto_downscale must be disabled BEFORE setting downscale, or
        # scenedetect ignores the value and logs a warning.
        manager.auto_downscale = False
        manager.downscale = max(
            1, int(round((video.frame_size[1] or T.SCENEDETECT_DOWNSCALE_HEIGHT)
                         / T.SCENEDETECT_DOWNSCALE_HEIGHT))
        )
        manager.add_detector(
            AdaptiveDetector(
                adaptive_threshold=T.ADAPTIVE_THRESHOLD,
                min_scene_len=T.ADAPTIVE_MIN_SCENE_LEN,
                window_width=T.ADAPTIVE_WINDOW_WIDTH,
                min_content_val=T.ADAPTIVE_MIN_CONTENT_VAL,
            )
        )
        manager.detect_scenes(video, show_progress=False)
        scenes = manager.get_scene_list()
        # Scene boundaries after the first: each is a candidate discontinuity.
        return [int(s[0].get_frames()) for s in scenes[1:]]
    except Exception as exc:
        protocol.log(f"warning: scenedetect failed on {media_path}: {exc}")
        return []


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _fmt_t(t: float) -> str:
    return f"{t:.1f}s"


def run(media_path: str, on_progress: Any = None) -> dict[str, Any]:
    """Run the temporal check. Returns a CheckReport-shaped dict plus internals."""
    with Clip(media_path) as clip:
        stride = temporal_stride(clip.fps, T.TEMPORAL_MAX_EFFECTIVE_FPS)
        sample_fps = (clip.fps / stride) if clip.fps > 0 else 0.0

        dis = _make_dis()
        prev_gray: np.ndarray | None = None
        prev_bgr: np.ndarray | None = None
        prev_idx = 0

        frames_idx: list[int] = []      # index of the SECOND frame of each pair
        times: list[float] = []
        naive: list[float] = []
        warps: list[float] = []
        ratios: list[float] = []
        valid_fracs: list[float] = []
        top5: list[float] = []
        top2: list[float] = []
        bgr_mae: list[float] = []
        luma: list[float] = []
        luma_idx: list[int] = []
        luma_t: list[float] = []

        work_h = work_w = 0
        n_seen = 0
        for idx, t, frame in clip.frames(stride=stride):
            n_seen += 1
            work = downscale_to_width(frame, T.TEMPORAL_WORKING_WIDTH)
            gray = to_gray(work)
            work_h, work_w = gray.shape[:2]
            luma.append(float(gray.mean()))
            luma_idx.append(idx)
            luma_t.append(t)

            if prev_gray is not None:
                nd = float(np.abs(gray - prev_gray).mean())
                flow_f = dis.calc(prev_gray.astype(np.uint8), gray.astype(np.uint8), None)
                flow_b = dis.calc(gray.astype(np.uint8), prev_gray.astype(np.uint8), None)
                mask, vfrac = fb_consistency_mask(flow_f, flow_b)
                we = warp_error(prev_gray, gray, flow_f, mask)

                # Ratio is only meaningful when something actually changed; below
                # the floor it is a quotient of two noise terms.
                ratio = (we / nd) if nd >= T.CHURN_MIN_NAIVE_DIFF else 0.0

                frames_idx.append(idx)
                times.append(t)
                naive.append(nd)
                warps.append(we)
                ratios.append(min(ratio, 2.0))
                valid_fracs.append(vfrac)
                top5.append(flow_magnitude_topk(flow_f, T.DYNAMIC_TOP_FRACTION))
                top2.append(flow_magnitude_topk(flow_f, T.STATIC_TOP_FRACTION))
                bgr_mae.append(float(np.abs(work.astype(np.float32) - prev_bgr).mean()))

                if on_progress and len(frames_idx) % 25 == 0:
                    on_progress(len(frames_idx))

            prev_gray = gray
            prev_bgr = work.astype(np.float32)
            prev_idx = idx

        clip_fps = clip.fps
        duration = clip.duration_sec or (times[-1] if times else 0.0)

    if n_seen == 0:
        return {
            "verdict": "fail",
            "score": 0,
            "reason": "no frames could be decoded — the file is empty or corrupt",
            "details": {"framesDecoded": 0},
            "evidence_frames": [],
            "series": [],
        }
    if len(ratios) < 2:
        return {
            "verdict": "skip",
            "score": 100,
            "reason": f"clip too short to measure temporal integrity ({n_seen} frame(s) decoded)",
            "details": {"framesDecoded": n_seen, "workingWidth": T.TEMPORAL_WORKING_WIDTH},
            "evidence_frames": [],
            "series": [],
        }

    a_naive = np.array(naive)
    a_warp = np.array(warps)
    a_ratio = np.array(ratios)
    a_valid = np.array(valid_fracs)
    a_t = np.array(times)
    a_top5 = np.array(top5)
    a_top2 = np.array(top2)
    min_side = min(work_h, work_w) or T.TEMPORAL_WORKING_WIDTH
    sample_dt = (1.0 / sample_fps) if sample_fps > 0 else 0.0

    # -- churn: motion-inexplicable change, sustained ------------------------
    trustworthy = a_valid >= T.VALID_FRACTION_MIN
    churn_gate = (a_naive >= T.CHURN_MIN_NAIVE_DIFF) & trustworthy
    churn_runs: list[dict[str, Any]] = []
    for s, e in hysteresis_runs(
        a_ratio, T.RATIO_MORPH_MIN, T.RATIO_CHURN_SUSTAIN, churn_gate
    ):
        t0 = float(a_t[s])
        t1 = float(a_t[e]) + sample_dt
        dur = max(sample_dt, t1 - t0)
        seg_warp = a_warp[s : e + 1]
        # Severity 0-1 scaled on the RTS §5 warp bands.
        severity = float(
            np.clip(
                (seg_warp.mean() - T.WARP_GREEN_MAX) / max(1e-6, T.WARP_AMBER_MAX - T.WARP_GREEN_MAX),
                0.0,
                1.0,
            )
        )
        # Even a low-warp run is not innocent if the ratio is extreme.
        severity = max(severity, float(np.clip((a_ratio[s : e + 1].mean() - T.RATIO_MORPH_MIN) / 0.4, 0.0, 1.0)))
        peak_i = int(s + np.argmax(a_ratio[s : e + 1]))
        churn_runs.append(
            {
                "startSec": round(t0, 3),
                "endSec": round(t1, 3),
                "durationSec": round(dur, 3),
                "peakRatio": round(float(a_ratio[peak_i]), 3),
                "peakFrame": int(frames_idx[peak_i]),
                "peakSec": round(float(a_t[peak_i]), 3),
                "meanWarp": round(float(seg_warp.mean()), 3),
                "severity": round(severity, 3),
                "sustained": dur > T.CHURN_SUSTAIN_SEC,
            }
        )

    # -- luma flicker: MAD spikes gated by FFT periodicity (RTS §3) ----------
    a_luma = np.array(luma)
    hp = highpass_2nd_diff(a_luma / max(1e-6, float(a_luma.mean())))
    interior = hp[1:-1] if hp.size > 2 else hp
    thr = mad_threshold(interior)
    spike_mask = np.abs(hp) > thr
    spike_mask[0] = spike_mask[-1] = False  # padded ends carry no information
    mean_luma = float(a_luma.mean())
    # A relative outlier that swings less than one luma code value is invisible
    # on any display, so it is not a defect no matter how many sigmas it is.
    spike_idx = [
        int(i)
        for i in np.flatnonzero(spike_mask)
        if abs(float(hp[i])) * mean_luma >= T.FLICKER_EVENT_MIN_LUMA
    ]
    par, peak_hz = periodicity_par(a_luma, sample_fps)
    periodic = (
        par >= T.FLICKER_PAR_MIN
        and T.FLICKER_PEAK_BAND_HZ[0] <= peak_hz <= T.FLICKER_PEAK_BAND_HZ[1]
    )
    # Robust amplitude of the high-passed series, in normalized-luma units.
    hp_amplitude = float(np.median(np.abs(interior))) * T.MAD_TO_SIGMA if interior.size else 0.0
    isolated = 0 < len(spike_idx) <= T.FLICKER_ISOLATED_MAX_EVENTS

    # Two detection paths, because they are blind to different things:
    #  - MAD spikes localize ISOLATED events but cannot see a continuous
    #    periodic flicker (every sample is equally extreme, so the robust spread
    #    absorbs the signal and nothing is an outlier);
    #  - PAR + amplitude sees the periodic case but does not localize it.
    periodic_flicker = periodic and hp_amplitude >= T.FLICKER_MIN_AMPLITUDE
    flicker_confirmed = (bool(spike_idx) and (periodic or isolated)) or periodic_flicker

    flicker_events: list[dict[str, Any]] = []
    if flicker_confirmed:
        event_idx = spike_idx
        if not event_idx and periodic_flicker:
            # No outliers to point at: report the largest excursions instead so
            # the UI still has timestamps and evidence frames.
            order = [
                int(i)
                for i in np.argsort(np.abs(hp))[::-1]
                if abs(float(hp[i])) * mean_luma >= T.FLICKER_EVENT_MIN_LUMA
            ]
            event_idx = sorted(order[: T.MAX_EVIDENCE_FRAMES])
        for i in event_idx:
            flicker_events.append(
                {
                    "frame": int(luma_idx[i]),
                    "sec": round(float(luma_t[i]), 3),
                    "amplitude": round(float(abs(hp[i]) * float(a_luma.mean())), 3),
                }
            )

    # -- discontinuity candidates cross-checked against the ratio ------------
    flow_median = float(np.median(a_top5)) if a_top5.size else 0.0
    morph_events: list[dict[str, Any]] = []
    jump_events: list[dict[str, Any]] = []
    suppressed = 0

    # Independent confirmation: a ratio above 1.0 means motion compensation made
    # the residual worse than doing nothing, which coherent motion cannot cause.
    # These need no scenedetect candidate — the measurement IS the evidence.
    confirmed_idx: set[int] = set()
    for j in np.flatnonzero((a_ratio >= T.RATIO_MORPH_CONFIRM) & churn_gate):
        j = int(j)
        confirmed_idx.add(j)
        morph_events.append(
            {
                "frame": int(frames_idx[j]),
                "sec": round(float(a_t[j]), 3),
                "ratio": round(float(a_ratio[j]), 3),
                "naiveDiff": round(float(a_naive[j]), 3),
                "warpErr": round(float(a_warp[j]), 3),
                "source": "warp-ratio",
            }
        )

    for cut_frame in scene_cut_frames(media_path):
        if not frames_idx:
            break
        j = int(np.argmin(np.abs(np.array(frames_idx) - cut_frame)))
        # Only trust a candidate we actually sampled near.
        if abs(frames_idx[j] - cut_frame) > max(1, stride):
            continue
        if j in confirmed_idx:
            continue  # already reported by the warp-ratio path
        r = float(a_ratio[j])
        ev = {
            "frame": int(frames_idx[j]),
            "sec": round(float(a_t[j]), 3),
            "ratio": round(r, 3),
            "naiveDiff": round(float(a_naive[j]), 3),
            "warpErr": round(float(a_warp[j]), 3),
            "source": "scenedetect",
        }
        if r >= T.RATIO_MORPH_MIN:
            morph_events.append(ev)
        elif r <= T.RATIO_JUMP_MAX:
            spike = a_top5[j] > max(1e-6, flow_median) * T.FLOW_SPIKE_K
            if spike:
                ev["flowMag"] = round(float(a_top5[j]), 3)
                jump_events.append(ev)
            else:
                suppressed += 1
        else:
            suppressed += 1

    # -- static / frozen output (RTS §4) -------------------------------------
    is_moving, dyn_thres, n_dynamic = dynamic_degree(a_top5, min_side)
    static_thres = T.STATIC_FLOW_COEF * min_side / 256.0
    static_pairs = a_top2 < static_thres
    static_score = static_flicker_score(np.array(bgr_mae)[static_pairs]) if static_pairs.any() else None
    # Requires BOTH low flow and almost no pixel change — otherwise a slow but
    # perfectly legitimate pan reads as a frozen generation.
    static_output = (not is_moving) and float(np.median(a_naive)) < T.STATIC_OUTPUT_MAX_NAIVE_DIFF

    # -- score ----------------------------------------------------------------
    score = 100.0
    for run_info in churn_runs:
        score -= T.TEMPORAL_CHURN_PENALTY_PER_SEC * run_info["durationSec"] * max(0.25, run_info["severity"])
    score -= min(T.TEMPORAL_FLICKER_PENALTY_MAX, T.TEMPORAL_FLICKER_PENALTY * len(flicker_events))
    score -= T.TEMPORAL_MORPH_PENALTY * len(morph_events)
    score -= T.TEMPORAL_JUMP_PENALTY * len(jump_events)
    if static_output:
        score -= T.TEMPORAL_STATIC_PENALTY
    if static_score is not None and static_score < T.STATIC_MAE_WARN:
        score -= T.TEMPORAL_FLICKER_PENALTY
    score = int(round(max(0.0, min(100.0, score))))

    sustained_churn = [c for c in churn_runs if c["sustained"]]
    if morph_events or jump_events or sustained_churn:
        verdict = "fail"
    elif churn_runs or flicker_events or static_output or (
        static_score is not None and static_score < T.STATIC_MAE_PASS
    ):
        verdict = "flag"
    else:
        verdict = "pass"
    if verdict == "fail":
        score = min(score, T.OVERALL_FAIL_CAP)

    # -- reason ---------------------------------------------------------------
    parts: list[str] = []
    for c in sorted(churn_runs, key=lambda x: -x["severity"])[:2]:
        parts.append(
            f"generative churn {_fmt_t(c['startSec'])}–{_fmt_t(c['endSec'])} "
            f"(warp ratio peaks {c['peakRatio']:.2f})"
        )
    for m in morph_events[:2]:
        parts.append(f"morph event at {_fmt_t(m['sec'])} (ratio {m['ratio']:.2f})")
    for j in jump_events[:2]:
        parts.append(f"geometric jump at {_fmt_t(j['sec'])} (ratio {j['ratio']:.2f})")
    if flicker_events:
        stamps = ", ".join(_fmt_t(f["sec"]) for f in flicker_events[:3])
        detail = f"periodic {peak_hz:.1f}Hz" if periodic else "isolated"
        parts.append(f"luma flicker at {stamps} ({detail})")
    if static_output:
        parts.append(
            f"static output — only {n_dynamic} of {len(a_top5)} frame pairs show "
            "real motion; the generation may have frozen"
        )
    if static_score is not None and static_score < T.STATIC_MAE_PASS:
        parts.append(f"pixel flicker on static content (VBench score {static_score:.4f})")
    if not parts:
        parts.append(
            f"stable across {len(a_ratio)} frame pairs "
            f"(warp ratio median {float(np.median(a_ratio)):.2f}, "
            f"warp error median {float(np.median(a_warp)):.1f}/255)"
        )
    low_valid = int((~trustworthy).sum())
    if low_valid:
        parts.append(
            f"{low_valid} pair(s) had too little flow-consistent area to gate on "
            "(heavy occlusion or motion blur)"
        )
    reason = "; ".join(parts)

    # -- evidence: the worst 2-4 frames --------------------------------------
    scored: dict[int, tuple[float, str]] = {}

    def _offer(frame: int, weight: float, caption: str) -> None:
        if frame not in scored or scored[frame][0] < weight:
            scored[frame] = (weight, caption)

    for m in morph_events:
        _offer(m["frame"], 3.0 + m["ratio"], f"morph event (ratio {m['ratio']:.2f})")
    for j in jump_events:
        _offer(j["frame"], 2.5, f"geometric jump (ratio {j['ratio']:.2f})")
    for c in churn_runs:
        _offer(
            c["peakFrame"],
            2.0 + c["severity"],
            f"generative churn (ratio {c['peakRatio']:.2f}, warp {c['meanWarp']:.1f}/255)",
        )
    for f in flicker_events:
        _offer(f["frame"], 1.5, f"luma flicker (Δ{f['amplitude']:.1f}/255)")
    if not scored and a_ratio.size:
        worst = int(np.argmax(a_ratio))
        _offer(
            int(frames_idx[worst]),
            1.0,
            f"worst frame pair (ratio {float(a_ratio[worst]):.2f})",
        )

    ranked = sorted(scored.items(), key=lambda kv: -kv[1][0])[: T.MAX_EVIDENCE_FRAMES]
    if verdict == "pass":
        ranked = ranked[:1]
    evidence_frames = [
        {"frame": int(f), "t": round(float(f) / clip_fps if clip_fps > 0 else 0.0, 3), "caption": cap}
        for f, (_w, cap) in ranked
    ]

    series = [
        {"t": round(float(t), 3), "v": round(float(v), 4)} for t, v in zip(a_t, a_ratio)
    ]

    details: dict[str, Any] = {
        "workingWidth": T.TEMPORAL_WORKING_WIDTH,
        "workingHeight": int(work_h),
        "sampleFps": round(sample_fps, 3),
        "framePairs": int(a_ratio.size),
        "durationSec": round(float(duration), 3),
        "warpErrMedian": round(float(np.median(a_warp)), 3),
        "warpErrP95": round(float(np.percentile(a_warp, 95)), 3),
        "naiveDiffMedian": round(float(np.median(a_naive)), 3),
        "ratioMedian": round(float(np.median(a_ratio)), 3),
        "ratioP95": round(float(np.percentile(a_ratio, 95)), 3),
        "validFractionMedian": round(float(np.median(a_valid)), 3),
        "untrustworthyPairs": low_valid,
        "churnWindows": churn_runs,
        "morphEvents": morph_events,
        "jumpEvents": jump_events,
        "suppressedCandidates": suppressed,
        "flickerEvents": flicker_events,
        "flickerPar": round(par, 2),
        "flickerPeakHz": round(peak_hz, 3),
        "flickerPeriodic": bool(periodic),
        "flickerAmplitude": round(hp_amplitude, 5),
        "isMoving": bool(is_moving),
        "dynamicThreshold": round(dyn_thres, 3),
        "dynamicPairs": n_dynamic,
        "staticOutput": bool(static_output),
        "staticSegmentPairs": int(static_pairs.sum()),
        "staticFlickerScore": round(static_score, 5) if static_score is not None else None,
    }

    return {
        "verdict": verdict,
        "score": score,
        "reason": reason,
        "series": series,
        "threshold": T.RATIO_MORPH_MIN,
        "evidence_frames": evidence_frames,
        "details": details,
    }
