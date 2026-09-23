from __future__ import annotations

import re
from typing import Any

SENTENCE_END = re.compile(r"(?<=[。！？!?])")
PAGE_LABEL = re.compile(r"^(?:[0-9０-９]{1,6}|[ivxlcdmIVXLCDM]{1,12})$")
CHAPTER_LABEL = re.compile(
    r"(?:第.{1,16}[章節部]|序章|終章|まえがき|あとがき|はじめに|おわりに|プロローグ|エピローグ)"
)
OCR_ORIENTATIONS = frozenset({"VERTICAL", "HORIZONTAL"})


def detect_ocr_orientation(regions: list[dict[str, Any]]) -> str:
    """Infer direction only when LINE/COLUMN geometry provides clear evidence."""
    vertical_score = horizontal_score = 0.0
    for region in regions:
        if region.get("kind", "LINE") == "ELEMENT":
            continue
        try:
            width = float(region["right"]) - float(region["left"])
            height = float(region["bottom"]) - float(region["top"])
        except (KeyError, TypeError, ValueError):
            continue
        if width <= 0 or height <= 0 or width * height < 0.001:
            continue
        if height >= width * 2:
            vertical_score += width * height * (height / width)
        elif width >= height * 2:
            horizontal_score += width * height * (width / height)
    if vertical_score > horizontal_score:
        return "VERTICAL"
    if horizontal_score > vertical_score:
        return "HORIZONTAL"
    return "UNKNOWN"


def resolve_ocr_orientation(override: str | None, book_orientation: str | None, regions: list[dict[str, Any]]) -> str:
    """Reviewer choice wins; otherwise keep book metadata before OCR auto-detection."""
    if override in OCR_ORIENTATIONS:
        return override
    if book_orientation in OCR_ORIENTATIONS:
        return book_orientation
    return detect_ocr_orientation(regions)


def _ordered(regions: list[dict[str, Any]], orientation: str) -> list[dict[str, Any]]:
    if orientation == "VERTICAL":
        return sorted(regions, key=lambda region: (-float(region["right"]), float(region["top"])))
    return sorted(regions, key=lambda region: (float(region["top"]), float(region["left"])))


def _inside(point: dict[str, Any], region: dict[str, Any]) -> bool:
    return (
        float(region["left"]) <= float(point["x"]) <= float(region["right"])
        and float(region["top"]) <= float(point["y"]) <= float(region["bottom"])
    )


def _segment_intersects_box(a: dict[str, Any], b: dict[str, Any], region: dict[str, Any]) -> bool:
    if _inside(a, region) or _inside(b, region):
        return True
    x1, y1, x2, y2 = float(a["x"]), float(a["y"]), float(b["x"]), float(b["y"])
    left, top, right, bottom = (float(region[key]) for key in ("left", "top", "right", "bottom"))
    dx, dy = x2 - x1, y2 - y1
    lower, upper = 0.0, 1.0
    for p, q in ((-dx, x1 - left), (dx, right - x1), (-dy, y1 - top), (dy, bottom - y1)):
        if p == 0:
            if q < 0:
                return False
            continue
        ratio = q / p
        if p < 0:
            lower = max(lower, ratio)
        else:
            upper = min(upper, ratio)
        if lower > upper:
            return False
    return True


def _intersects(points: list[dict[str, Any]], region: dict[str, Any]) -> bool:
    return any(_inside(point, region) for point in points) or any(
        _segment_intersects_box(first, second, region) for first, second in zip(points, points[1:])
    )


def _sentences(text: str) -> list[str]:
    return [part.strip() for part in SENTENCE_END.split(text) if part.strip()]


def annotation_candidates(
    points: list[dict[str, Any]], regions: list[dict[str, Any]], orientation: str
) -> dict[str, str]:
    ordered = _ordered([region for region in regions if str(region.get("text", "")).strip()], orientation)
    intersecting = [region for region in ordered if _intersects(points, region)]
    quote = "".join(str(region["text"]).strip() for region in intersecting)
    body_regions = [
        region for region in ordered
        if not PAGE_LABEL.fullmatch(str(region["text"]).strip())
        and not CHAPTER_LABEL.fullmatch(str(region["text"]).strip())
    ]
    reading_text = "".join(str(region["text"]).strip() for region in body_regions)
    sentences = _sentences(reading_text)
    before = after = ""
    normalized_quote = re.sub(r"\s+", "", quote)
    if normalized_quote:
        for index, sentence in enumerate(sentences):
            normalized_sentence = re.sub(r"\s+", "", sentence)
            if normalized_quote in normalized_sentence or normalized_sentence in normalized_quote:
                before = sentences[index - 1] if index else ""
                after = sentences[index + 1] if index + 1 < len(sentences) else ""
                break
    page_values = [str(region["text"]).strip() for region in ordered if PAGE_LABEL.fullmatch(str(region["text"]).strip())]
    chapter_values = [str(region["text"]).strip() for region in ordered if CHAPTER_LABEL.search(str(region["text"]).strip())]
    return {
        "quote": quote,
        "contextBefore": before,
        "contextAfter": after,
        "pageLabel": page_values[-1] if page_values else "不明",
        "chapterLabel": chapter_values[0] if chapter_values else "不明",
    }


def ocr_transcription(regions: list[dict[str, Any]], orientation: str) -> str:
    """Return every non-blank OCR region in page reading order."""
    if orientation not in OCR_ORIENTATIONS:
        return ""
    ordered = _ordered([region for region in regions if str(region.get("text", "")).strip()], orientation)
    return "".join(str(region["text"]).strip() for region in ordered)


def capture_ocr_candidates(regions: list[dict[str, Any]], orientation: str) -> dict[str, str]:
    """Candidate text from OCR run on the authoritative Capture rectangle."""
    return {
        "quote": ocr_transcription(regions, orientation),
        "contextBefore": "",
        "contextAfter": "",
        "pageLabel": "",
        "chapterLabel": "",
    }
