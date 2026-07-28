"""Remap a logo's cool navy/teal palette onto the studio's warm theme.

The brand artwork is built from a cool band (teal ~150 deg through navy ~265
deg). This rotates that band onto the warm band around book-cloth clay
(#CC785C, hue ~15 deg) while preserving each pixel's brightness and the spread
within the band, so the accent "RT" stays distinct from the wordmark instead of
flattening into one tone.

Saturation is scaled by a curve of brightness. Without it the fully saturated
near-blacks (the dark field, ~40% of the image) turn chocolate brown; the curve
drops them to near-neutral warm ink while leaving the bright accents vivid.

Both logo assets are processed with identical parameters so they match.

Usage:
    python scripts/recolor-logo.py <source>.png assets/logo-app-bone.png
"""
from __future__ import annotations

import sys

import numpy as np
from PIL import Image

# Source band to rotate, in degrees. Starts in the yellow-greens rather than at
# teal so the whole heatmap ramp (yellow -> green -> cyan -> blue) rotates as one
# piece; a narrower band left the hot core behind and split the ramp in two.
COOL_MIN, COOL_MAX = 65.0, 265.0
# Destination band, centred on the theme accent #CC785C (hue ~15 deg).
WARM_MIN, WARM_MAX = 6.0, 36.0


def recolor(src_path: str, dst_path: str) -> None:
    src = Image.open(src_path)
    has_alpha = src.mode in ("RGBA", "LA") or "transparency" in src.info
    src = src.convert("RGBA")

    data = np.array(src).astype(float)
    rgb, alpha = data[..., :3] / 255.0, data[..., 3:]

    # RGB -> HSV, vectorised.
    mx, mn = rgb.max(-1), rgb.min(-1)
    delta = mx - mn
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    hue = np.zeros_like(mx)
    nz = delta > 1e-6
    idx = (mx == r) & nz; hue[idx] = ((g - b)[idx] / delta[idx]) % 6
    idx = (mx == g) & nz; hue[idx] = ((b - r)[idx] / delta[idx]) + 2
    idx = (mx == b) & nz; hue[idx] = ((r - g)[idx] / delta[idx]) + 4
    hue *= 60.0
    sat = np.where(mx > 1e-6, delta / np.maximum(mx, 1e-6), 0.0)
    val = mx

    cool = (hue >= COOL_MIN) & (hue <= COOL_MAX)
    hue = np.where(
        cool,
        WARM_MIN + (hue - COOL_MIN) * (WARM_MAX - WARM_MIN) / (COOL_MAX - COOL_MIN),
        hue,
    )
    sat = np.where(cool, sat * np.clip(0.06 + 1.15 * val ** 1.4, 0.0, 1.0), sat)

    # The heatmap's hot core is near-maximum brightness and saturation, which
    # after rotation glares against the muted palette. Ease down only the
    # brightest saturated pixels in the band, leaving mid-tones untouched so the
    # ramp keeps its shape.
    glare = cool & (val > 0.80) & (sat > 0.30)
    val = np.where(glare, val * (1.0 - 0.22 * (val - 0.80) / 0.20), val)

    # HSV -> RGB.
    sector = np.floor(hue / 60.0).astype(int) % 6
    frac = hue / 60.0 - np.floor(hue / 60.0)
    p = val * (1 - sat)
    q = val * (1 - frac * sat)
    t = val * (1 - (1 - frac) * sat)
    out = np.zeros_like(rgb)
    for k, channels in enumerate([(val, t, p), (q, val, p), (p, val, t),
                                  (p, q, val), (t, p, val), (val, p, q)]):
        mask = sector == k
        for c in range(3):
            out[..., c][mask] = channels[c][mask]

    result = np.concatenate([np.clip(out * 255, 0, 255), alpha], axis=-1)
    image = Image.fromarray(result.astype(np.uint8), "RGBA")
    if not has_alpha:
        image = image.convert("RGB")
    image.save(dst_path)
    print(f"{src_path} -> {dst_path}  ({image.mode}, {image.size[0]}x{image.size[1]})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    recolor(sys.argv[1], sys.argv[2])
