"""A downloaded publisher image made safe to serve: decoded by Pillow under a decompression-bomb
guard, checked, turned upright (EXIF orientation), converted to sRGB, stripped of every piece of
metadata, and re-encoded as still WebP at 480 and 960 px wide (never upscaled).

The bytes are untrusted. Only JPEG, PNG, GIF, WebP and AVIF are opened (the file's own signature
decides, and Pillow is limited to those decoders); SVG never reaches Pillow; an animated file, one
over MAX_PIXELS, one narrower than MIN_SOURCE_W or with an odd shape is refused. The output is
built from raw pixels, so nothing of the original file (EXIF, XMP, ICC, comments) can survive."""

from __future__ import annotations

import hashlib
import io
import warnings
from dataclasses import dataclass, field

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024  # the download cap (fetch side)
MAX_PIXELS = 40_000_000  # decompression-bomb guard: 40 MP, far above any news photo
MAX_SIDE = 20_000  # the API's bound on width/height
MIN_SOURCE_W = 300  # narrower is a thumbnail or an icon, not a story photo (web/lib/media.ts agrees)
MIN_SOURCE_H = 150
MAX_TALL = 2.5  # height / width above this: a long graphic or a screenshot
MAX_WIDE = 4.0  # width / height above this: a banner
WIDTHS = (480, 960)
# Per-variant size targets; quality steps down until a variant fits. The API refuses over 600 KB.
TARGET_BYTES = {480: 160 * 1024, 960: 420 * 1024}
API_MAX_VARIANT_BYTES = 600 * 1024
QUALITIES = (80, 70, 60, 50, 40)
FORMATS = ("JPEG", "PNG", "GIF", "WEBP", "AVIF")  # a camera MPO opens through the JPEG decoder

# Pillow's own guard too: a warning over MAX_PIXELS (made an error below), an error over twice that.
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class ImageRejected(Exception):
    """This image cannot be used; the message says why (for the log)."""


@dataclass
class Variant:
    w: int
    h: int
    data: bytes  # still WebP, no metadata

    @property
    def bytes(self) -> int:
        return len(self.data)


@dataclass
class Processed:
    sha256: str  # of the bytes as downloaded
    width: int  # after EXIF orientation
    height: int
    color: str  # dominant colour, "#rrggbb"
    source_format: str
    variants: list[Variant] = field(default_factory=list)

    @property
    def smallest(self) -> Variant:
        return min(self.variants, key=lambda v: v.w)


def sniff(data: bytes) -> str | None:
    """The format by the file's own signature (a server's Content-Type is not trusted)."""
    if data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    if data[4:8] == b"ftyp" and data[8:12] in (b"avif", b"avis"):
        return "AVIF"
    return None


def _open(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data), formats=FORMATS)


def _is_animated(im: Image.Image) -> bool:
    # A camera's MPO (a JPEG with a second, smaller picture) is not an animation: its first frame is used.
    return bool(getattr(im, "is_animated", False)) and im.format != "MPO"


def _to_srgb(im: Image.Image) -> Image.Image:
    """An RGB image in sRGB: palette and grey expanded, an embedded ICC profile (CMYK included)
    converted, transparency flattened onto white."""
    if im.mode in ("P", "PA"):
        im = im.convert("RGBA")
    icc = im.info.get("icc_profile")
    if icc and im.mode in ("RGB", "RGBA", "CMYK", "L"):
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            out_mode = "RGBA" if im.mode == "RGBA" else "RGB"
            im = ImageCms.profileToProfile(im, src, ImageCms.createProfile("sRGB"), outputMode=out_mode)
        except (ImageCms.PyCMSError, OSError, ValueError, TypeError):
            pass  # a broken profile: the plain conversion below
    if im.mode in ("RGBA", "LA") or (im.mode in ("RGB", "L") and "transparency" in im.info):
        rgba = im.convert("RGBA")
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.getchannel("A"))
        return flat
    if im.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
        im = im.convert("I").point(lambda x: x * (1 / 256)).convert("L")  # 16-bit grey to 8-bit
    return im.convert("RGB")


def _clean(im: Image.Image) -> Image.Image:
    """The same pixels in a new image that carries nothing else (no info, no EXIF, no profile)."""
    return Image.frombytes("RGB", im.size, im.tobytes())


def dominant_color(im: Image.Image) -> str:
    """The most common colour of a small median-cut palette, as #rrggbb."""
    small = im.convert("RGB").resize((48, max(1, round(48 * im.height / im.width))), Image.Resampling.BILINEAR)
    q = small.quantize(colors=5, method=Image.Quantize.MEDIANCUT)
    counts = q.getcolors() or [(1, 0)]
    idx = max(counts)[1]
    pal = q.getpalette() or [0, 0, 0]
    r, g, b = pal[idx * 3 : idx * 3 + 3]
    return f"#{r:02x}{g:02x}{b:02x}"


def encode_webp(im: Image.Image, target: int) -> bytes:
    """Still, lossy WebP with no metadata chunk, at the best quality that fits `target` bytes (or the
    API's hard limit at the lowest quality)."""
    data = b""
    for q in QUALITIES:
        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=q, method=4)
        data = buf.getvalue()
        if len(data) <= target:
            return data
    if len(data) > API_MAX_VARIANT_BYTES:
        raise ImageRejected(f"a {im.width} px WebP is still {len(data)} bytes at quality {QUALITIES[-1]}")
    return data


def variant_widths(width: int) -> list[int]:
    """480 and 960, each capped at the original's width (never upscaled): a 700 px original gives
    480 and 700, a 400 px one only 400."""
    return sorted({min(w, width) for w in WIDTHS})


def process_image(data: bytes, *, min_width: int = MIN_SOURCE_W) -> Processed:
    """Check, clean and re-encode one downloaded image. Raises ImageRejected with the reason."""
    if not data:
        raise ImageRejected("empty body")
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ImageRejected(f"over {MAX_DOWNLOAD_BYTES} bytes")
    fmt = sniff(data)
    if fmt is None:
        head = data[:200].lstrip().lower()
        what = "an SVG" if head.startswith((b"<svg", b"<?xml")) or b"<svg" in head else "not a JPEG/PNG/GIF/WebP/AVIF"
        raise ImageRejected(f"file is {what}")
    sha = hashlib.sha256(data).hexdigest()
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with _open(data) as probe:
                w, h = probe.size
                if w * h > MAX_PIXELS or w > MAX_SIDE or h > MAX_SIDE:
                    raise ImageRejected(f"{w}x{h} px is over the {MAX_PIXELS} pixel guard")
                if _is_animated(probe):
                    raise ImageRejected("animated image")
                probe.verify()
            with _open(data) as im:
                if im.format == "MPO":
                    im.seek(0)
                im.load()
                upright = ImageOps.exif_transpose(im)
        except ImageRejected:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as e:
            raise ImageRejected(f"decompression bomb: {e}") from None
        except (UnidentifiedImageError, OSError, SyntaxError, ValueError, TypeError, EOFError) as e:
            raise ImageRejected(f"undecodable {fmt}: {type(e).__name__}: {str(e)[:120]}") from None
        except Exception as e:  # noqa: BLE001 - a decoder fed hostile bytes can fail in any way
            raise ImageRejected(f"undecodable {fmt}: {type(e).__name__}: {str(e)[:120]}") from None
    width, height = upright.size
    if width < min_width:
        raise ImageRejected(f"{width} px wide (under {min_width})")
    if height < MIN_SOURCE_H:
        raise ImageRejected(f"{height} px high (under {MIN_SOURCE_H})")
    if height > MAX_TALL * width or width > MAX_WIDE * height:
        raise ImageRejected(f"{width}x{height} is not a photo's shape")
    try:
        rgb = _clean(_to_srgb(upright))
    except Exception as e:  # noqa: BLE001 - an odd mode or a broken profile: not worth a story image
        raise ImageRejected(f"colour conversion failed: {type(e).__name__}: {str(e)[:120]}") from None
    variants: list[Variant] = []
    color = ""
    for vw in variant_widths(width):
        vh = max(1, round(vw * height / width))
        sized = rgb if (vw, vh) == rgb.size else rgb.resize((vw, vh), Image.Resampling.LANCZOS, reducing_gap=3.0)
        color = color or dominant_color(sized)  # from the smallest variant: cheap, and the same picture
        variants.append(Variant(vw, vh, encode_webp(_clean(sized), TARGET_BYTES.get(vw, TARGET_BYTES[960]))))
    return Processed(sha256=sha, width=width, height=height, color=color, source_format=fmt, variants=variants)


def webp_chunks(data: bytes) -> list[str]:
    """The RIFF chunk ids of a WebP file (for checks and tests): VP8 / VP8L / VP8X, ALPH, ICCP, EXIF, ..."""
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("not a WebP file")
    out, pos = [], 12
    while pos + 8 <= len(data):
        cid = data[pos : pos + 4].decode("latin-1")
        size = int.from_bytes(data[pos + 4 : pos + 8], "little")
        out.append(cid)
        pos += 8 + size + (size & 1)
    return out
