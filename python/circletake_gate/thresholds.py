"""Every tunable constant used by the gate checks, in one place.

House rule (AGENTS.md #7): no inline magic numbers in check code. Each constant
below cites its provenance in ``research/RESEARCH-tech.md`` (RT) or
``research/RESEARCH-temporal-supplement.md`` (RTS). Values marked "measured" were
empirically verified on macOS arm64 / CPython 3.13; values marked "starting band"
are calibration candidates that the synthetic fixtures exercise.

``research/RESEARCH-anatomy-supplement.md`` is cited as RAS.

Project-level overrides (ProjectSettings.gate) are applied by the host by passing
explicit CLI flags; this module holds the defaults.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Decode / working resolution
# ---------------------------------------------------------------------------

METRIC_MAX_HEIGHT = 720
"""Decode ceiling for metric passes. RT §Temporal: ~0.12 s compute per second of
720p video. Larger sources are downscaled; smaller are never upscaled."""

TEMPORAL_WORKING_WIDTH = 480
"""Canonical working width for ALL temporal metrics (RTS §2).

Flow is the dominant cost and every warp/flow metric is resolution-dependent, so
the width is fixed rather than derived from the source. Reported back as
``details.workingWidth`` so a report's numbers are always interpretable."""

COLOR_STAT_SIZE = 128
"""Edge length for Lab colour statistics. RT §Continuity: CIEDE2000 costs 25 ms
per frame at 512x512 but only 1.8 ms at 128x128, with no loss of robust-stat
fidelity (we use medians/IQR, not per-pixel detail)."""

TEMPORAL_MAX_EFFECTIVE_FPS = 24.0
"""Upper bound on temporal sampling. Native fps is used when lower; above this we
stride, because consecutive-pair metrics at 60 fps measure sensor noise rather
than generative artifacts, and cost scales linearly."""

DEFAULT_SAMPLE_FPS = 3.0
"""Default sampling rate for per-frame model checks (identity / anatomy).
RT §Identity: "sample ~3fps" — 5-8 frames per segment is sufficient for a robust
median, and SFace costs ~4.6 ms per face."""

# ---------------------------------------------------------------------------
# Temporal — optical flow and warp error
# ---------------------------------------------------------------------------

WARP_NOISE_FLOOR = 0.8
"""Bilinear interpolation noise floor in 0-255 mean-abs units (RT §Temporal,
measured). No warp-error threshold may be set below this: remapping a frame onto
itself with a perfect flow field still costs ~0.8/255 in resampling error."""

WARP_GREEN_MAX = 3.0
"""Masked mean-abs warp error (0-255, at 480px) below which a pair is clean.
RTS §5 starting band."""

WARP_AMBER_MAX = 6.0
"""Masked mean-abs warp error above which a pair is in the red band. RTS §5:
green <3.0, amber 3.0-6.0, red >6.0."""

FB_CONSISTENCY_ALPHA = 0.01
"""Multiplier on (|w|^2 + |w_hat|^2) in the Sundaram/Brox forward-backward
consistency test (RTS §1): valid iff |w + w_hat|^2 < a*(|w|^2+|w_hat|^2) + b."""

FB_CONSISTENCY_BETA = 0.5
"""Additive term of the FB-consistency test (RTS §1). Keeps small-motion pixels
from being rejected purely by numerical noise."""

VALID_FRACTION_MIN = 0.4
"""If the FB-consistency + in-frame mask keeps less than this fraction of pixels,
the pair's warp metric is untrustworthy and must NOT be gated on (RTS §1). The
pair is still recorded, with the fact noted in details."""

RATIO_MORPH_MIN = 0.6
"""warp_err/naive_diff at or above which change is NOT explainable by coherent
motion — generative churn / morph / flicker (RT §Temporal, measured:
flicker/churn 0.917 vs pan baseline 0.206)."""

RATIO_CHURN_SUSTAIN = 0.45
"""Hysteresis floor for extending a churn window.

A churn window is ENTERED at RATIO_MORPH_MIN and EXTENDED while the ratio stays
above this. Measured: sustained generative boiling produces a plateau that
oscillates around 0.6 (0.49-0.64 across a one-second window), so a single
threshold shatters one real event into a dozen one-frame fragments and the
"sustained for > 0.5 s" rule can never fire. 0.45 sits well above the 0.206 pan
baseline and below the 0.6 confirmation line."""

RATIO_MORPH_CONFIRM = 1.0
"""Warp ratio at which a morph event is confirmed WITHOUT a scenedetect candidate.

ratio > 1.0 means motion compensation made the residual WORSE than doing nothing
— the flow field actively hurt. Coherent motion cannot produce that; only
genuinely unrelated frame content can. Measured: clean pan peaks at 0.09,
sustained churn at 0.64, a crossfade morph at 1.11."""

RATIO_JUMP_MAX = 0.25
"""warp_err/naive_diff at or below which the change IS explainable by motion.
Combined with a flow-magnitude spike this is a geometric jump/pop (measured
0.062); without a flow spike it is a scenedetect false positive to suppress."""

CHURN_MIN_NAIVE_DIFF = 2.0
"""Minimum naive frame difference (0-255 mean-abs) for a ratio to mean anything.
Below this the frame pair is essentially identical and the ratio is a quotient of
two noise terms — reported as 0 rather than a spurious high ratio."""

FLOW_SPIKE_K = 3.0
"""Multiples of the clip's own median flow magnitude that constitute a flow
spike, used to separate a geometric jump from a suppressed false positive.
Relative-to-self per SPEC gate doctrine."""

CHURN_SUSTAIN_SEC = 0.5
"""Duration of continuous above-RATIO_MORPH_MIN churn that escalates from flag to
fail. Per brief: "sustained churn (ratio>0.6 for >0.5s)"."""

# ---------------------------------------------------------------------------
# Temporal — luma flicker (MAD detector + FFT periodicity, RTS §3)
# ---------------------------------------------------------------------------

FLICKER_HIGHPASS_KERNEL = (-0.5, 1.0, -0.5)
"""Second-difference high-pass applied to the mean-luma series (RT §Temporal).
Removes ramps (legitimate exposure changes) and keeps single-frame excursions."""

MAD_TO_SIGMA = 1.4826
"""Consistency constant converting median-absolute-deviation to a Gaussian sigma
estimate. Standard robust statistics; cited by RT §Temporal's 3x1.4826xMAD rule."""

FLICKER_MAD_K = 3.0
"""Flag |highpass| above FLICKER_MAD_K * MAD_TO_SIGMA * MAD — a 3-sigma robust
outlier of the second-difference luma series (RT §Temporal)."""

FLICKER_PAR_MIN = 10.0
"""Peak-to-average power ratio above which the luma series is narrowband periodic
= genuine flicker rather than legitimate content change (RTS §3). Amplitude alone
does not discriminate; periodicity does."""

FLICKER_FREQ_MIN_HZ = 0.5
"""Lower bound of the PAR search band. Below 0.5 Hz is scene-level exposure
drift, not flicker (RTS §3)."""

FLICKER_PEAK_BAND_HZ = (1.0, 15.0)
"""Frequency band in which a PAR peak counts as flicker (RTS §3). Peaks outside
this band are pans, dissolves, or aliasing."""

FLICKER_MIN_AMPLITUDE = 0.004
"""Minimum robust amplitude (in normalized-luma units, i.e. fraction of mean
luma) of the high-passed series for PERIODIC flicker to be reported.

Needed because a perfectly periodic flicker has NO MAD outliers — every sample
is equally extreme, so the robust spread absorbs the signal and the 3-sigma test
finds nothing. The MAD detector localizes isolated events; this amplitude gate
plus the PAR test catches the continuous periodic case the MAD detector is blind
to by construction. Measured: clean pans sit near 0.0005, an injected 3% flicker
near 0.02."""

FLICKER_EVENT_MIN_LUMA = 1.0
"""Minimum absolute amplitude (0-255 luma) for a single flicker event to be
reported at all.

The MAD test is purely relative, so in a very quiet series a 3-sigma outlier can
still be visually nothing. Measured: a real injected flicker event swings
3.8/255, while a spurious outlier in a clean pan swings 0.077/255 — a 50x gap.
Below one code value nothing is visible on any display, so it is not a defect."""

FLICKER_ISOLATED_MAX_EVENTS = 3
"""A small number of MAD spikes with no periodic structure still flags (isolated
one-frame luma pops are real artifacts). More than this without periodicity reads
as content, and PAR must carry the decision (RTS §3)."""

# ---------------------------------------------------------------------------
# Temporal — discontinuity detection (scenedetect cross-check)
# ---------------------------------------------------------------------------

ADAPTIVE_THRESHOLD = 3.0
"""scenedetect AdaptiveDetector adaptive_threshold. RT §Temporal gives the
verified 3.0-4.0 window; we sit at the SENSITIVE end deliberately.

This detector only produces CANDIDATES — every one is cross-checked against the
flow ratio, which suppresses false positives (ratio <= 0.25 with smooth flow).
So the candidate stage wants high recall, not precision. Measured: a real cut
under a continuous pan scored an adaptive ratio of 3.06, which 3.5 silently
discarded; the ratio cross-check then never got the chance to rule on it."""

ADAPTIVE_MIN_SCENE_LEN = 8
"""AdaptiveDetector min_scene_len in frames (RT §Temporal)."""

ADAPTIVE_WINDOW_WIDTH = 3
"""AdaptiveDetector rolling-average window width in frames (RT §Temporal)."""

ADAPTIVE_MIN_CONTENT_VAL = 18
"""AdaptiveDetector min_content_val floor — suppresses adaptive triggers on
low-contrast content (RT §Temporal)."""

SCENEDETECT_DOWNSCALE_HEIGHT = 360
"""Height scenedetect operates at (RT §Temporal: "downscale to ~360p")."""

# ---------------------------------------------------------------------------
# Temporal — static/frozen output (VBench dynamic-degree port, RTS §4)
# ---------------------------------------------------------------------------

DYNAMIC_FLOW_COEF = 6.0
"""Flow-magnitude threshold coefficient for the dynamic-degree test; the actual
threshold is DYNAMIC_FLOW_COEF * min(H, W) / 256 so it is resolution-normalized
(RTS §4)."""

DYNAMIC_TOP_FRACTION = 0.05
"""Fraction of largest flow magnitudes averaged per pair for the dynamic-degree
test — top 5% (RTS §4). Means over the whole frame are dominated by background."""

DYNAMIC_MIN_PAIR_FRACTION = 4.0 / 16.0
"""A clip is "moving" iff at least round(4*T/16) of its T pairs exceed the
dynamic threshold (RTS §4, VBench rule)."""

STATIC_FLOW_COEF = 3.0
"""Stricter coefficient marking individual STATIC segments, on which raw MAE
flicker becomes valid and VBench-comparable (RTS §4)."""

STATIC_TOP_FRACTION = 0.02
"""Top 2% flow magnitudes for the static-segment filter (RTS §4)."""

STATIC_OUTPUT_MAX_NAIVE_DIFF = 2.0
"""A clip is only reported as "static output" when the dynamic-degree test says
non-moving AND its median naive frame difference is below this (0-255).

Guard against a real false positive: the dynamic-degree threshold scales as
6.0*min(H,W)/256, which at our 480px working width demands roughly 8 px of
motion per frame. A slow, perfectly legitimate pan moves less than that and would
otherwise be reported as a frozen generation. A genuinely frozen output has
almost no pixel change at all, so requiring both conditions separates "not much
motion" from "nothing is happening"."""

STATIC_MAE_PASS = 0.990
"""Published VBench temporal-flickering band: S = 1 - meanMAE/255 over static
segments; >= 0.990 passes (RTS §4)."""

STATIC_MAE_WARN = 0.980
"""S in 0.980-0.990 warns; below 0.980 fails (RTS §4, published anchors)."""

# ---------------------------------------------------------------------------
# Temporal — scoring weights
# ---------------------------------------------------------------------------

TEMPORAL_CHURN_PENALTY_PER_SEC = 45.0
"""Score points removed per second of churn at full severity. Tuned so that a
0.5 s full-severity churn window lands the score in flag territory and a
multi-second one drives it below the fail cap."""

TEMPORAL_FLICKER_PENALTY = 12.0
"""Points per confirmed flicker event."""

TEMPORAL_FLICKER_PENALTY_MAX = 36.0
"""Cap on cumulative flicker penalty — flicker alone should flag, not annihilate
the score; the verdict rule carries the severity signal."""

TEMPORAL_MORPH_PENALTY = 35.0
"""Points per confirmed morph event (a cut where no cut should be)."""

TEMPORAL_JUMP_PENALTY = 25.0
"""Points per confirmed geometric jump/pop event."""

TEMPORAL_STATIC_PENALTY = 20.0
"""Points removed when the clip reads as static output (generation froze)."""

# ---------------------------------------------------------------------------
# Identity (SFace 128-D cosine, RT §Identity)
# ---------------------------------------------------------------------------

YUNET_SCORE_THRESHOLD = 0.7
"""YuNet detection confidence floor (RT §Identity)."""

YUNET_NMS_THRESHOLD = 0.3
"""YuNet NMS IoU threshold — OpenCV zoo default."""

YUNET_TOP_K = 5000
"""YuNet pre-NMS candidate cap — OpenCV zoo default."""

MIN_FACE_SIDE_PX = 64
"""Minimum face box side, at detection scale, for a face to be scoreable. Smaller
crops do not survive alignCrop into SFace's 112x112 input."""

IDENTITY_PASS = 0.75
"""Cosine p10 at or above which identity passes. RT §Identity: same-identity
floor under abuse measured at >= 0.755."""

IDENTITY_WARN = 0.55
"""Cosine p10 in 0.55-0.75 flags (drift / instability)."""

IDENTITY_HARD_FAIL = 0.363
"""OpenCV's own default cosine threshold. RT §Identity: far too permissive for
continuity gating, so we use it only as the "reads as a different person" floor
(different person measured at 0.198)."""

IDENTITY_HEAD_TAIL_SKIP = 0.10
"""Fraction of the clip skipped at head and tail when aggregating (RT §Identity)
— fades and title cards are not identity evidence."""

IDENTITY_MULTIFACE_FRAME_FRACTION = 0.25
"""More than one face in at least this fraction of sampled frames triggers
clustering instead of largest-face tracking (RT §Identity)."""

IDENTITY_CLUSTER_COSINE_CUT = 0.5
"""Agglomerative cosine-similarity cut separating identity clusters
(RT §Identity: "cos cut ~0.5")."""

IDENTITY_MIN_SCOREABLE_FRACTION = 0.30
"""Below this fraction of sampled frames carrying a qualifying face the verdict
is 'skip', never 'fail' (RT §Identity)."""

IDENTITY_DRIFT_DELTA = 0.15
"""A rolling-median cosine decline greater than this within one take reads as
"identity drifts over the take"."""

IDENTITY_ROLLING_WINDOW = 5
"""Samples per rolling-median window for the drift test. Odd, and small enough
that a 2-second take still yields several windows."""

IDENTITY_WORST_WINDOW = 5
"""Samples in the "worst window" metric — the sustained low-similarity stretch
that a viewer would actually notice."""

# ---------------------------------------------------------------------------
# Anatomy (MediaPipe HandLandmarker, RT §Anatomy)
# ---------------------------------------------------------------------------

HAND_MIN_FRAME_FRACTION = 0.15
"""Hands must be detected in at least this fraction of sampled frames for the
check to run at all; otherwise verdict 'skip', reason 'no hands in frame'."""

HAND_DETECTION_CONFIDENCE = 0.5
"""HandLandmarker min_hand_detection_confidence — MediaPipe default."""

HAND_PRESENCE_CONFIDENCE = 0.5
"""HandLandmarker min_hand_presence_confidence — MediaPipe default."""

HAND_TRACKING_CONFIDENCE = 0.5
"""HandLandmarker min_tracking_confidence — MediaPipe default."""

HAND_MAX_HANDS = 2
"""num_hands. More than two hands in frame is a different (unsupported) problem."""

HAND_DROPOUT_FLAG = 0.10
"""Detection-dropout rate that warns (RAS §5: dropout_rate > 10% warn). RT
§Anatomy calls dropout the strongest single signal."""

HAND_DROPOUT_FAIL = 0.25
"""Dropout rate that reaches fail level (RAS §5: > 25% fail) — but anatomy only
actually fails when this coincides with extreme bone-length evidence."""

HAND_DROPOUT_EGREGIOUS = 0.50
"""Dropout so severe that, combined with extreme bone-length error, the check is
allowed to fail outright (brief: "it fails only on egregious")."""

HANDEDNESS_SCORE_WARN = 0.85
"""Mean handedness score below which detections are low-confidence (RAS §5).

Hand landmarks carry NO visibility/presence field — both are None — so the
handedness score plus the dropout rate are the only confidence signals
available. (Pose landmarks do have visibility; hands do not.)"""

HANDEDNESS_SCORE_FAIL = 0.70
"""Mean handedness score at fail level (RAS §5)."""

#: Bone connectivity of the canonical hand template, in template order (RAS §6).
BONE_EDGES = (
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
    (5, 9), (9, 13), (13, 17),
)

#: Canonical palm-normalized bone lengths, measured (RAS §6). 23 bones, aligned
#: index-for-index with BONE_EDGES. Palm scale = ||W0 - W9||, hence entry 8 = 1.0.
BONE_TEMPLATE = (
    0.367, 0.338, 0.390, 0.336,
    1.017, 0.285, 0.219, 0.315,
    1.000, 0.362, 0.322, 0.266,
    0.941, 0.314, 0.261, 0.239,
    0.853, 0.228, 0.227, 0.205,
    0.244, 0.272, 0.224,
)

BONE_LOG_RATIO_WARN = 0.15
"""BLR = mean|log(r_i / canon_i)| over the 23 bones, on WORLD landmarks. Above
0.15 warns (RAS §6). World landmarks are required: 2D projected bone lengths vary
8-12% with posture alone, which would swamp the signal."""

BONE_LOG_RATIO_FAIL = 0.25
"""BLR above which the hand's proportions are anatomically wrong (RAS §6)."""

BONE_LOG_RATIO_MAX_WARN = 0.5
"""A single bone this far off warns even when the mean looks acceptable
(RAS §6: "max > 0.5 warn")."""

BONE_LENGTH_CV_FLAG = 0.12
"""Coefficient of variation of palm-normalized bone lengths ACROSS TIME. Real
hands are rigid, so temporal variance is direct evidence of generative
instability — RAS §6 keeps this as a primary signal alongside the template BLR."""

BONE_LENGTH_CV_FAIL = 0.25
"""Bone-length CV that counts as "extreme" for the egregious-only fail rule."""

JITTER_ACCEL_SUSPICIOUS = 0.05
"""Median per-landmark ACCELERATION, ||P(t) - 2P(t-1) + P(t-2)|| / palm_scale on
WORLD landmarks (RAS §4). Acceleration separates real from generated hands by
76x; velocity only by 7x — so acceleration is the metric, not velocity. The
model's own jitter floor is ~0.004-0.03 depending on image noise."""

JITTER_ACCEL_STRONG = 0.15
"""Median acceleration constituting a strong flag (RAS §4)."""

PLANARITY_WARN = 0.08
"""Finger planarity s3/s1 from the centered SVD of [MCP, PIP, DIP, TIP] world
points (RAS §7). Real fingers are near-planar: measured 0.002-0.034."""

PLANARITY_FAIL = 0.12
"""Finger planarity at fail level (RAS §7)."""

HANDEDNESS_FLIP_FLAG = 1
"""Handedness flips on a TRACKED hand: >=1 is worth investigating and is named in
the reason (RAS §10). Association by nearest wrist must happen first, or flips
are an artifact of MediaPipe's unstable hand ordering rather than a real signal."""

HANDEDNESS_FLIP_FAIL = 3
"""Flip count at fail level (RAS §10)."""

#: Per-joint range-of-motion hard gates in degrees, with the +10 deg tolerance
#: already applied (RAS §8). NOTE: the DIP ~= (2/3)*PIP coupling heuristic is
#: deliberately NOT used — measured to be a false-positive generator on
#: MediaPipe's z-depth.
JOINT_ROM_DEG = {
    "mcp_flex": (0.0, 100.0),
    "pip_flex": (0.0, 120.0),
    "dip_flex": (0.0, 100.0),
    "mcp_abduction": (-25.0, 25.0),
}

JOINT_ANGLE_RANGE_DEG = (-10.0, 110.0)
"""Coarse physiological flexion envelope (RT §Anatomy). Retained as the summary
range quoted in reasons; JOINT_ROM_DEG carries the per-joint gates."""

HYPEREXTENSION_FRAME_FLAG = 0.10
"""Fraction of hand frames containing an out-of-range joint that flags."""

ANATOMY_SELF_CAL_MULTIPLE = 2.5
"""Self-calibration multiple: a signal must exceed both its absolute threshold
and this multiple of the clip's own median to count (RT §Anatomy: "self-calibrate
against clip's own median")."""

HAND_ASSOCIATION_MAX_DIST = 0.25
"""Maximum normalized wrist displacement (fraction of frame diagonal) for two
detections in consecutive frames to be the same hand (RAS §3). MediaPipe does NOT
keep hand ordering stable across frames; without nearest-wrist association every
temporal metric is garbage (measured)."""

# ---------------------------------------------------------------------------
# Continuity (RT §Continuity)
# ---------------------------------------------------------------------------

CONTINUITY_COMPARE_FRAMES = 12
"""Frames compared at each cut point: LAST-N of the previous shot against
FIRST-N of this take, and symmetrically for the next shot (RT §Continuity)."""

DELTA_E_INVISIBLE = 1.0
"""Mean CIEDE2000 below which a grade difference is invisible (RT §Continuity).
ΔE 1.0 ~ 3% exposure or a 2/255 white-balance shift."""

DELTA_E_SUBTLE = 2.0
"""1.0-2.0 is subtle but acceptable — still a pass."""

DELTA_E_WARN = 5.0
"""2.0-5.0 warns; above 5.0 fails (RT §Continuity bands)."""

CONTINUITY_Z_K = 3.0
"""Multiples of within-take standard deviation a cross-cut delta must exceed to
count. RT §Continuity calls this the content-independence trick: raw ΔE across
shots is content-confounded, so it is never a standalone gate."""

CONTINUITY_CLIP_HIGH = 254
"""Pixel value at or above which a sample counts as clipped highlight."""

CONTINUITY_CLIP_LOW = 1
"""Pixel value at or below which a sample counts as crushed shadow."""

CONTINUITY_CLIP_DELTA_FLAG = 0.05
"""Change in clipped-pixel percentage across the cut that flags on its own."""

# ---------------------------------------------------------------------------
# Conformance
# ---------------------------------------------------------------------------

DURATION_FLAG_TOLERANCE = 0.10
"""Duration within +/-10% of expected passes; beyond flags (SPEC gate engine)."""

DURATION_FAIL_TOLERANCE = 0.25
"""Beyond +/-25% of expected fails."""

FPS_MISMATCH_TOLERANCE = 0.02
"""Relative fps tolerance; 23.976 vs 24 must not flag (0.1% apart), 24 vs 30 must."""

ASPECT_MISMATCH_TOLERANCE = 0.02
"""Relative aspect-ratio tolerance. Aspect mismatch fails: it cannot be fixed in
the edit without reframing."""

RESOLUTION_FLOOR_TOLERANCE = 0.98
"""Delivered resolution below this multiple of expected flags (a 1918px master
against a 1920px expectation is not worth a flag; 1280 against 1920 is)."""

FROZEN_CHECK_FRAMES = 12
"""Head/tail frames examined for frozen or black content."""

FROZEN_DIFF_THRESHOLD = WARP_NOISE_FLOOR
"""Pairwise naive mean-abs difference (0-255) below which consecutive frames are
duplicates. Anchored to the measured interpolation noise floor — anything quieter
than resampling noise is a literally repeated frame."""

BLACK_LUMA_THRESHOLD = 8.0
"""Mean luma (0-255) below which a frame reads as black."""

FROZEN_BIT_IDENTICAL = True
"""Prefer the bit-identical test for freeze detection (RAS §Technical.3).

A decoder or generation freeze emits BIT-IDENTICAL frames — sigma(diff) is
exactly 0.0 — whereas a legitimately static shot still carries sensor dither.
``np.array_equal`` is both the correct discriminator and the fast path; the
FROZEN_DIFF_THRESHOLD below remains as the softer secondary test."""

SHARPNESS_WINDOW_SEC = 0.5
"""Window length for the variance-of-Laplacian sharpness series."""

SHARPNESS_ANALYSIS_LONG_EDGE = 1024
"""Long edge every frame is resampled to (INTER_AREA) BEFORE variance-of-
Laplacian (RAS §Technical.1). varLap is violently resolution-dependent — and
counter-intuitively DOWNSCALING RAISES it — so comparing raw varLap across
different-sized takes is meaningless without a fixed analysis resolution."""

SHARPNESS_NORMALIZED_SHARP = 200.0
"""Contrast-normalized sharpness = varLap / mean(gray)^2 * 1e4. Above 200 is
sharp (RAS §Technical.1 bands)."""

SHARPNESS_NORMALIZED_OK = 50.0
"""50-200 is acceptable sharpness (RAS §Technical.1)."""

SHARPNESS_NORMALIZED_SOFT = 5.0
"""5-50 is soft (warn); below 5 fails (RAS §Technical.1). Advisory in v1 — the
sharpness signal is appended to the reason and never changes a verdict alone."""

SHARPNESS_COLLAPSE_RATIO = 0.20
"""Windows whose normalized sharpness falls below this fraction of the clip's own
median are soft relative to the take itself. RT §Sharpness: sharp 860 vs blur-9
17 vs blur-21 3.6, normalized to the clip median. Advisory only."""

NOISE_CLEAN = 2.0
"""Immerkaer noise estimate sigma below which the image is clean
(RAS §Technical.2). sigma = sqrt(pi/2) / (6*(W-2)*(H-2)) * sum|I (*) K| with
K = [[1,-2,1],[-2,4,-2],[1,-2,1]], evaluated on the flattest 32x32 tile.
Pairing this with varLap is mandatory: varLap alone cannot tell sharp from
noisy, and noisy footage with a high varLap is NOT sharp."""

NOISE_GRAIN = 4.0
"""2-4 reads as grain (RAS §Technical.2)."""

NOISE_WARN = 8.0
"""4-8 warns; above 8 fails (RAS §Technical.2). Advisory in v1."""

NOISE_TILE = 32
"""Edge length of the flattest-tile search window for the noise estimate."""

BLOCKINESS_CLEAN = 1.05
"""8-pixel block-boundary MAD ratio below which there is no visible blocking
(RAS §Technical.4). Advisory string only."""

BLOCKINESS_WARN = 1.15
"""1.15-1.35 warns (RAS §Technical.4)."""

BLOCKINESS_FAIL = 1.35
"""Above 1.35 is heavy macroblocking (RAS §Technical.4). Advisory in v1."""

CLIP_HI_WARN = 0.01
"""Per-channel fraction of samples >= 254 that is worth mentioning (RAS
§Technical.5). NEVER fails on its own: a white studio background legitimately
clips 56% of samples, so the reason string carries a contiguity caveat."""

CLIP_HI_FLAG = 0.05
"""Clipped-highlight fraction at flag level, still advisory (RAS §Technical.5)."""

CLIP_LO_WARN = 0.02
"""Per-channel fraction of samples <= 1 worth mentioning (RAS §Technical.5)."""

CLIP_LO_FLAG = 0.10
"""Crushed-shadow fraction at flag level, still advisory (RAS §Technical.5)."""

# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------

OVERALL_FAIL_CAP = 40
"""A hard fail caps the overall score. Mirrors OVERALL_FAIL_CAP in
src/shared/types.ts — these two MUST stay in sync."""

PASS_FLOOR = 85
"""All-pass reports should land at or above this. Mirrors src/shared/types.ts."""

SUGGESTED_WINDOW_MIN_SEC = 1.5
"""Shortest span the engine will suggest as a select window. Below this there is
nothing to cut with."""

SUGGESTED_WINDOW_CLEAN_FRACTION = 0.95
"""If the qualifying span covers at least this fraction of the clip, the whole
clip is effectively clean and no suggestion is emitted."""

# ---------------------------------------------------------------------------
# Thumbnails / evidence
# ---------------------------------------------------------------------------

POSTER_POSITION = 0.25
"""Poster frame at 25% of duration — past any fade-in, before any fade-out."""

POSTER_WIDTH = 640
STRIP_WIDTH = 240
STRIP_COUNT = 8
EVIDENCE_WIDTH = 960
EVIDENCE_JPEG_QUALITY = 90
MAX_EVIDENCE_FRAMES = 4
"""Worst-frame evidence per check: 2-4 frames. More is noise in the UI."""

MIN_EVIDENCE_FRAMES = 2
"""Minimum evidence frames for a non-passing check. One frame reads as an
anecdote; two let the reviewer confirm the artifact is real before seeking."""
