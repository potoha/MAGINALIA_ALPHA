from marginalia_reviewer.candidates import (
    annotation_candidates,
    capture_ocr_candidates,
    detect_ocr_orientation,
    ocr_transcription,
    resolve_ocr_orientation,
)


def test_intersection_reading_order_sentence_and_labels() -> None:
    regions = [
        {"left": .1, "top": .1, "right": .9, "bottom": .2, "text": "序章"},
        {"left": .1, "top": .3, "right": .9, "bottom": .4, "text": "前の文。"},
        {"left": .1, "top": .5, "right": .9, "bottom": .6, "text": "重要な文。"},
        {"left": .1, "top": .7, "right": .9, "bottom": .8, "text": "次の文。"},
        {"left": .45, "top": .9, "right": .55, "bottom": .98, "text": "12"},
    ]
    stroke = [{"x": .05, "y": .55}, {"x": .95, "y": .55}]

    result = annotation_candidates(stroke, regions, "HORIZONTAL")

    assert result == {
        "quote": "重要な文。",
        "contextBefore": "前の文。",
        "contextAfter": "次の文。",
        "pageLabel": "12",
        "chapterLabel": "序章",
    }


def test_capture_candidate_uses_crop_ocr_in_vertical_reading_order() -> None:
    # These are crop-local OCR regions. The original page's full-height
    # columns are deliberately not passed here: they cannot define Quote.
    regions = [
        {"left": .10, "top": .0, "right": .30, "bottom": 1.0, "text": "左側の選択文字"},
        {"left": .70, "top": .0, "right": .90, "bottom": 1.0, "text": "右側の選択文字"},
    ]
    result = capture_ocr_candidates(regions, "VERTICAL")
    assert result["quote"] == "右側の選択文字左側の選択文字"
    assert ocr_transcription(regions, "VERTICAL") == "右側の選択文字左側の選択文字"


def test_ocr_orientation_auto_detects_columns_and_does_not_default_unknown_to_horizontal() -> None:
    vertical_regions = [
        {"left": .05, "top": .05, "right": .16, "bottom": .95, "kind": "LINE", "text": "左列"},
        {"left": .72, "top": .05, "right": .83, "bottom": .95, "kind": "LINE", "text": "右列"},
        {"left": .38, "top": .05, "right": .49, "bottom": .95, "kind": "LINE", "text": "中央列"},
    ]
    horizontal_regions = [
        {"left": .05, "top": .65, "right": .95, "bottom": .76, "kind": "LINE", "text": "下の行"},
        {"left": .05, "top": .15, "right": .95, "bottom": .26, "kind": "LINE", "text": "上の行"},
    ]

    assert detect_ocr_orientation(vertical_regions) == "VERTICAL"
    assert ocr_transcription(vertical_regions, detect_ocr_orientation(vertical_regions)) == "右列中央列左列"
    assert detect_ocr_orientation(horizontal_regions) == "HORIZONTAL"
    assert ocr_transcription(horizontal_regions, detect_ocr_orientation(horizontal_regions)) == "上の行下の行"
    assert resolve_ocr_orientation("AUTO", None, []) == "UNKNOWN"
    assert ocr_transcription([], "UNKNOWN") == ""
    assert resolve_ocr_orientation("AUTO", "HORIZONTAL", vertical_regions) == "HORIZONTAL"
    assert resolve_ocr_orientation("VERTICAL", "HORIZONTAL", horizontal_regions) == "VERTICAL"
