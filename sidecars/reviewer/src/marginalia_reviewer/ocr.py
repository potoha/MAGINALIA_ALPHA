from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from PIL import Image

from .config import load_json_object

NDLOCR_LITE_VERSION = "1.2.3"
NDLOCR_LITE_COMMIT = "c3cc7676e7f4613c6b5d51bfae7ca764098424d2"
NDLOCR_LITE_WINDOWS_SHA256 = "f9e615ca1bba70c48fee156e685631cc2ef413f5c18c06fcbb9a949382519668"


class OcrConfigurationError(ValueError):
    pass


def normalized_region_to_pixel_box(
    selected_region: dict[str, Any], image_width: int, image_height: int
) -> tuple[int, int, int, int]:
    """Convert the Android-owned normalized rectangle to a Pillow crop box."""
    if image_width <= 0 or image_height <= 0:
        raise ValueError("canonical image dimensions must be positive")
    values: dict[str, float] = {}
    for key in ("left", "top", "right", "bottom"):
        value = selected_region.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"selectedRegion.{key} must be a finite number")
        values[key] = float(value)
    if (
        values["left"] < 0
        or values["top"] < 0
        or values["right"] > 1
        or values["bottom"] > 1
        or values["right"] <= values["left"]
        or values["bottom"] <= values["top"]
    ):
        raise ValueError("selectedRegion must be a non-empty normalized rectangle")
    left = max(0, min(image_width, math.floor(values["left"] * image_width)))
    top = max(0, min(image_height, math.floor(values["top"] * image_height)))
    right = max(0, min(image_width, math.ceil(values["right"] * image_width)))
    bottom = max(0, min(image_height, math.ceil(values["bottom"] * image_height)))
    if right <= left or bottom <= top:
        raise ValueError("selectedRegion becomes empty at canonical-image resolution")
    return left, top, right, bottom


class NdlocrLiteAdapter:
    """Subprocess boundary for the locally installed, explicitly pinned NDLOCR-Lite."""

    def __init__(self, config_path: Path, timeout_seconds: int = 600) -> None:
        self.config_path = config_path
        self.timeout_seconds = timeout_seconds
        config = load_json_object(config_path)
        if config.get("engine") != "NDLOCR-Lite" or config.get("version") != NDLOCR_LITE_VERSION:
            raise OcrConfigurationError(
                f"NDLOCR-Lite config must pin engine=NDLOCR-Lite and version={NDLOCR_LITE_VERSION}"
            )
        if config.get("commit") != NDLOCR_LITE_COMMIT:
            raise OcrConfigurationError(f"NDLOCR-Lite config must pin commit={NDLOCR_LITE_COMMIT}")
        if config.get("distributionSha256") != NDLOCR_LITE_WINDOWS_SHA256:
            raise OcrConfigurationError(
                "NDLOCR-Lite config must pin the official Windows 1.2.3 distribution SHA-256"
            )
        command = config.get("command")
        if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
            raise OcrConfigurationError("NDLOCR-Lite config.command must be a non-empty string array")
        if not any("{input}" in item for item in command) or not any(
            "{output}" in item or "{outputDir}" in item for item in command
        ):
            raise OcrConfigurationError(
                "NDLOCR-Lite command must contain {input} and either {output} or {outputDir}"
            )
        executable = Path(command[0])
        if not executable.is_absolute() or not executable.is_file():
            raise OcrConfigurationError("NDLOCR-Lite command executable must be an existing absolute path")
        executable_sha256 = config.get("executableSha256")
        if not isinstance(executable_sha256, str) or re.fullmatch(r"[0-9a-fA-F]{64}", executable_sha256) is None:
            raise OcrConfigurationError("NDLOCR-Lite config.executableSha256 must be a SHA-256 hex digest")
        digest = hashlib.sha256()
        with executable.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        actual_executable_sha256 = digest.hexdigest()
        if actual_executable_sha256 != executable_sha256.casefold():
            raise OcrConfigurationError("NDLOCR-Lite command executable SHA-256 does not match configuration")
        self.command = command
        self.executable_sha256 = actual_executable_sha256

    def recognize(
        self, image_path: Path, expected_width: int, expected_height: int, page_id: str
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        with tempfile.TemporaryDirectory(prefix="marginalia-ocr-") as temporary:
            output_path = Path(temporary) / "result.json"
            command = [
                item.replace("{input}", str(image_path))
                .replace("{output}", str(output_path))
                .replace("{outputDir}", str(temporary))
                for item in self.command
            ]
            completed = subprocess.run(
                command,
                cwd=self.config_path.parent,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
                shell=False,
            )
            if completed.returncode:
                detail = (completed.stderr or completed.stdout).strip()[-1000:]
                raise RuntimeError(f"NDLOCR-Lite exited with {completed.returncode}: {detail}")
            if not output_path.is_file():
                candidates = list(Path(temporary).glob("*.json"))
                if len(candidates) != 1:
                    raise RuntimeError("NDLOCR-Lite did not create exactly one JSON output")
                output_path = candidates[0]
            try:
                raw: Any = json.loads(output_path.read_text(encoding="utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError("NDLOCR-Lite output is not valid UTF-8 JSON") from exc
        regions_value = raw.get("regions") if isinstance(raw, dict) else None
        if regions_value is None and isinstance(raw, dict) and isinstance(raw.get("result"), dict):
            regions_value = raw["result"].get("regions")
        if regions_value is None and isinstance(raw, dict):
            contents = raw.get("contents")
            if isinstance(contents, list) and len(contents) == 1 and isinstance(contents[0], list):
                regions_value = contents[0]
        if not isinstance(regions_value, list) or not all(isinstance(item, dict) for item in regions_value):
            raise RuntimeError("NDLOCR-Lite JSON must contain a regions array")
        image_value = raw.get("image") if isinstance(raw, dict) and isinstance(raw.get("image"), dict) else {}
        assert isinstance(image_value, dict)
        image_info = raw.get("imginfo") if isinstance(raw, dict) and isinstance(raw.get("imginfo"), dict) else {}
        assert isinstance(image_info, dict)
        reported_width = image_value.get("width", raw.get("imageWidth", raw.get("width", image_info.get("img_width"))))
        reported_height = image_value.get("height", raw.get("imageHeight", raw.get("height", image_info.get("img_height"))))
        if reported_width != expected_width or reported_height != expected_height:
            raise RuntimeError(
                "NDLOCR-Lite image dimensions do not match the canonical page "
                f"({reported_width}x{reported_height} != {expected_width}x{expected_height})"
            )
        regions = [
            self._normalize_region(region, index, expected_width, expected_height)
            | {"id": f"ndl:{page_id}:{index}"}
            for index, region in enumerate(regions_value)
        ]
        provenance = {
            "engine": "NDLOCR-Lite",
            "version": NDLOCR_LITE_VERSION,
            "commit": NDLOCR_LITE_COMMIT,
            "distributionSha256": NDLOCR_LITE_WINDOWS_SHA256,
            "executableSha256": self.executable_sha256,
            "executedAt": datetime.now(UTC).isoformat(timespec="seconds"),
            "raw": raw,
        }
        return regions, provenance

    def recognize_selected_region(
        self,
        image_path: Path,
        expected_width: int,
        expected_height: int,
        page_id: str,
        capture_id: str,
        selected_region: dict[str, Any],
    ) -> dict[str, Any]:
        """Run NDLOCR-Lite on a JPEG crop, never on intersecting page boxes."""
        pixel_box = normalized_region_to_pixel_box(selected_region, expected_width, expected_height)
        left, top, right, bottom = pixel_box
        with Image.open(image_path) as page:
            page.load()
            if page.size != (expected_width, expected_height):
                raise RuntimeError(
                    "canonical page dimensions do not match imported metadata "
                    f"({page.size[0]}x{page.size[1]} != {expected_width}x{expected_height})"
                )
            crop = page.crop(pixel_box)
            if crop.mode != "RGB":
                crop = crop.convert("RGB")
            with tempfile.TemporaryDirectory(prefix="marginalia-capture-ocr-") as temporary:
                crop_path = Path(temporary) / "selected-region.jpg"
                crop.save(crop_path, format="JPEG", quality=95)
                regions, provenance = self.recognize(
                    crop_path,
                    right - left,
                    bottom - top,
                    f"{page_id}:capture:{capture_id}",
                )
        return {
            "regions": regions,
            "provenance": provenance,
            "pixelBounds": {"left": left, "top": top, "right": right, "bottom": bottom},
        }

    @staticmethod
    def _normalize_region(
        region: dict[str, Any], index: int, image_width: int, image_height: int
    ) -> dict[str, Any]:
        def number(value: Any) -> float:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise RuntimeError(f"NDLOCR-Lite region {index} has invalid pixel coordinates")
            return float(value)

        box = region.get("boundingBox", region.get("bbox"))
        if isinstance(box, list) and len(box) == 4 and all(
            isinstance(point, list) and len(point) == 2 for point in box
        ):
            xs = [number(point[0]) for point in box]
            ys = [number(point[1]) for point in box]
            left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        elif isinstance(box, list) and len(box) == 4:
            x, y, width, height = (number(value) for value in box)
            left, top, right, bottom = x, y, x + width, y + height
        elif isinstance(box, dict):
            left = number(box.get("left", box.get("x")))
            top = number(box.get("top", box.get("y")))
            if "right" in box and "bottom" in box:
                right, bottom = number(box["right"]), number(box["bottom"])
            else:
                right = left + number(box.get("width"))
                bottom = top + number(box.get("height"))
        else:
            raise RuntimeError(f"NDLOCR-Lite region {index} has no pixel boundingBox")
        # NDLOCR-Lite's detector can overshoot an image boundary by a few
        # pixels. Keep that official-output rounding artefact from rejecting
        # the entire page, while still rejecting materially unsafe boxes.
        boundary_tolerance = 8.0
        if (
            left < -boundary_tolerance
            or top < -boundary_tolerance
            or right > image_width + boundary_tolerance
            or bottom > image_height + boundary_tolerance
        ):
            raise RuntimeError(f"NDLOCR-Lite region {index} is outside the canonical image")
        left = min(max(left, 0.0), float(image_width))
        top = min(max(top, 0.0), float(image_height))
        right = min(max(right, 0.0), float(image_width))
        bottom = min(max(bottom, 0.0), float(image_height))
        if right <= left or bottom <= top:
            raise RuntimeError(f"NDLOCR-Lite region {index} is outside or degenerate")
        return {
            "id": f"ndl:{index}",
            "left": left / image_width,
            "top": top / image_height,
            "right": right / image_width,
            "bottom": bottom / image_height,
            "kind": region.get("kind") if region.get("kind") in {"LINE", "COLUMN", "ELEMENT"} else "LINE",
            "text": region.get("text") if isinstance(region.get("text"), str) else "",
        }
