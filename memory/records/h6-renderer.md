---
id: planned.h6-renderer
updated: 2026-09-28
status: planned
kind: product-decision
---

# H.6 Renderer/editor refinement

Product Owner decisions:

1. Vertical writing must be practical for **writing/editing**, not only reading in vertical Preview.
2. Heading/outline hierarchy should live-render clearly.
3. Figures/images/tables should live-render correctly during authoring.
4. Normal Japanese prose paragraphs default to one-character first-line indentation.

Japanese paragraph rule:

- presentation only;
- do not insert full-width spaces into Markdown source;
- ordinary prose paragraphs only;
- headings, lists, blockquotes, code, tables, media captions, etc. are not blindly indented;
- horizontal and vertical presentation use the same semantic rule;
- implementation equivalent may use `text-indent: 1em` where appropriate.

Before implementing vertical editing, inspect current Monaco/Preview constraints. Avoid brittle coordinate transforms merely to force Monaco into a mode it does not naturally support.
