import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORT_PRESENTATION_SETTINGS,
  EXPORT_ORIENTATIONS,
  EXPORT_PAPER_SIZES,
  createExportPresentationSettings,
  isExportOrientation,
  isExportPaperSize
} from "./export-presentation-settings";

describe("ExportPresentationSettings", () => {
  it("provides the alpha defaults", () => {
    expect(DEFAULT_EXPORT_PRESENTATION_SETTINGS).toEqual({
      paperSize: "A4",
      orientation: "portrait",
      paragraphIndent: true,
      header: { left: "", center: "", right: "" },
      pageNumber: true
    });
  });

  it("accepts only the shared paper sizes and orientations", () => {
    expect(EXPORT_PAPER_SIZES).toEqual(["A3", "A4", "A5", "B3", "B4", "B5", "Letter", "Legal"]);
    expect(EXPORT_ORIENTATIONS).toEqual(["portrait", "landscape"]);
    expect(isExportPaperSize("B3")).toBe(true);
    expect(isExportPaperSize("ISO-B3")).toBe(false);
    expect(isExportOrientation("landscape")).toBe(true);
    expect(isExportOrientation("square")).toBe(false);
  });

  it("keeps JIS B-series names distinct from ISO or ad-hoc values", () => {
    expect(isExportPaperSize("B3")).toBe(true);
    expect(isExportPaperSize("B4")).toBe(true);
    expect(isExportPaperSize("B5")).toBe(true);
    expect(isExportPaperSize("JIS B3")).toBe(false);
    expect(isExportPaperSize("ISO B3")).toBe(false);
  });

  it("returns deeply immutable settings and applies only presentation input", () => {
    const source = "# Title\n\n本文\n";
    const settings = createExportPresentationSettings({
      paperSize: "B5",
      orientation: "landscape",
      paragraphIndent: false,
      header: { left: "MAGINALIA", center: "", right: "研究" },
      pageNumber: false
    });

    expect(settings.paperSize).toBe("B5");
    expect(settings.orientation).toBe("landscape");
    expect(settings.header.left).toBe("MAGINALIA");
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.header)).toBe(true);
    expect(source).toBe("# Title\n\n本文\n");
  });

  it("rejects unsupported values without normalizing them into another format", () => {
    expect(() => createExportPresentationSettings({ paperSize: "ISO-B3" })).toThrow(RangeError);
    expect(() => createExportPresentationSettings({ orientation: "square" })).toThrow(RangeError);
    expect(() => createExportPresentationSettings({ paragraphIndent: "yes" })).toThrow(TypeError);
  });
});
