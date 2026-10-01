#!/usr/bin/env python3
"""Keep website cover assets at 1200px / <=1MiB. Requires Pillow.

Run after fetch-artwork.mjs, or with --check to validate without changes.
Large PNGs become WebP; references and redirects retain old incoming URLs.
Original artwork remains in git history; these are the website copies.
"""
import argparse
import io
from pathlib import Path

from PIL import Image, ImageCms, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "merajmirzaei-site (4)"
MAX_EDGE = 1200
MAX_BYTES = 1024 * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    issues = []
    redirects = []
    for source in sorted((SITE / "images/covers").iterdir()):
        if source.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        size = source.stat().st_size
        with Image.open(source) as opened:
            if size <= MAX_BYTES and max(opened.size) <= MAX_EDGE:
                continue
            if args.check:
                issues.append(source.name)
                continue
            image = ImageOps.exif_transpose(opened)
            profile = opened.info.get("icc_profile")
            if profile and image.mode in {"RGB", "CMYK"}:
                image = ImageCms.profileToProfile(image, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                                                 ImageCms.createProfile("sRGB"), outputMode="RGB")
            image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
            webp = source.suffix.lower() in {".png", ".webp"}
            image = image.convert("RGBA" if webp and "A" in image.getbands() else "RGB")
            target = source.with_suffix(".webp") if webp else source
            quality = 85
            while True:
                buffer = io.BytesIO()
                if webp:
                    image.save(buffer, "WEBP", quality=quality, method=6)
                else:
                    image.save(buffer, "JPEG", quality=quality, optimize=True, progressive=True)
                encoded = buffer.getvalue()
                if len(encoded) <= MAX_BYTES:
                    break
                if quality > 65:
                    quality -= 10
                else:
                    image.thumbnail((int(image.width * 0.8), int(image.height * 0.8)), Image.Resampling.LANCZOS)
            target.write_bytes(encoded)
        if target != source:
            old = "/" + source.relative_to(SITE).as_posix()
            new = "/" + target.relative_to(SITE).as_posix()
            for path in SITE.rglob("*"):
                if path.suffix in {".html", ".js", ".json"}:
                    text = path.read_text()
                    if old in text:
                        path.write_text(text.replace(old, new))
            redirects.append(f"{old} {new} 301")
            source.unlink()
        print(f"{source.name}: {size:,} -> {len(encoded):,} bytes ({image.width}x{image.height})")
    if redirects:
        path = SITE / "_redirects"
        previous = path.read_text() if path.exists() else ""
        path.write_text(previous.rstrip() + ("\n" if previous else "") + "\n".join(redirects) + "\n")
    if issues:
        raise SystemExit("Oversized website covers: " + ", ".join(issues))


if __name__ == "__main__":
    main()
