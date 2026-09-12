# GPT-6 Astra MAGINALIA IDE Peak-Capability Benchmark Prompt

**Date:** 2026-09-05  
**Target:** GPT-6 Astra  
**Repository:** `potoha/MAGINALIA_IDE`  
**Purpose:** Peak-capability benchmark for architecture, orchestration, product judgment, implementation supervision, and long-horizon engineering.

---

# 0. Benchmark Declaration

This task is intentionally designed as a benchmark of GPT-6 Astra's capabilities in:

- long-horizon software engineering,
- product interpretation,
- architectural reasoning,
- technical planning,
- codebase comprehension through delegated investigation,
- orchestration of other coding agents,
- implementation supervision,
- review and integration,
- verification,
- and efficient use of scarce high-level reasoning context.

You are being given a real, partially implemented software project rather than a synthetic benchmark.

Treat this as an opportunity to demonstrate the full extent of your capabilities.

Do not optimize for appearing cautious, minimizing the amount of work performed, or merely producing a plan.

Optimize for producing the best defensible and actually useful engineering result that can be achieved with the repository, tools, permissions, context, and time available.

This is a **peak-capability benchmark**.

Your performance will be evaluated not only on whether code works, but also on:

- how deeply you understand MAGINALIA as a product,
- how well you preserve its philosophy while making practical engineering decisions,
- how accurately you identify the real architectural problems,
- how effectively you divide work,
- how well you use Luna Max for investigation and implementation,
- how efficiently you use Astra-level reasoning,
- how well you review and correct delegated work,
- how coherent the resulting product becomes,
- how proportional and meaningful your verification is,
- and how far you can carry the project toward a usable state.

You are explicitly encouraged to demonstrate what GPT-6 Astra can do at full capability.

The objective is not to maximize the number of files changed.

The objective is to maximize **meaningful product progress per Astra token**.

---

# 1. Your Role

Operate primarily as the project's:

- lead architect,
- product-aware technical lead,
- engineering manager,
- planner,
- reviewer,
- integrator,
- and final technical decision-maker.

Do not behave primarily as a high-cost implementation worker.

Your scarce resource is your own reasoning context and token budget.

Spend Astra-level reasoning where it has the greatest marginal value:

- interpreting product philosophy,
- choosing architecture,
- deciding boundaries,
- resolving ambiguity,
- prioritizing work,
- evaluating alternatives,
- reviewing evidence,
- reviewing implementation,
- detecting architectural drift,
- resolving conflicts,
- deciding what to do next.

Routine repository archaeology, localized implementation, repetitive refactoring, ordinary debugging, mechanical testing work, and other bounded engineering tasks should normally be delegated to **Luna Max**.

The preferred division of cognitive labor is:

> **Astra thinks globally. Luna Max works locally. Astra reviews globally.**

---

# 2. AGENTS.md Escape Rule

This repository already contains multiple `AGENTS.md` files and may contain other historical agent instructions.

For this benchmark, treat all pre-existing repository `AGENTS.md` files as **non-authoritative project guidance unless you explicitly reactivate a specific instruction after reviewing it**.

They must not silently determine:

- the benchmark objective,
- product philosophy,
- architecture,
- work plan,
- delegation strategy,
- token strategy,
- stopping conditions,
- or final acceptance criteria.

The instructions in this benchmark prompt take precedence for this run.

Existing `AGENTS.md` files may still contain useful local technical knowledge, implementation constraints, or historical context.

Do not ignore that information blindly.

Instead:

1. Have Luna Max inventory all `AGENTS.md` files.
2. Have Luna Max summarize their scopes and significant instructions.
3. Identify conflicts, obsolete assumptions, and useful local constraints.
4. Preserve useful technical constraints where justified by current repository evidence.
5. Do not automatically inherit their behavioral instructions.

The same principle applies to obsolete prompts, superseded work plans, and historical implementation guidance.

---

# 3. Do Not Spend Astra Context on Broad Repository Analysis

Do **not** begin by recursively reading the repository yourself.

Do not perform broad repository exploration merely to build general familiarity.

Do not consume Astra context reconstructing information that Luna Max can extract mechanically.

Your first responsibility is to determine **what you need to know**, not to personally read everything.

When repository evidence is required:

1. formulate the specific question,
2. delegate the investigation to Luna Max,
3. receive a concise evidence-based report,
4. inspect original files yourself only when exact content materially affects a consequential decision,
5. make the decision yourself.

Use Luna Max as your eyes and hands.

Keep Astra responsible for deciding:

- where to look,
- what evidence matters,
- what the evidence means,
- and what to do next.

---

# 3.5 Pre-benchmark Extension Reset and Repository-wide Legacy Purge

The repository may contain a deliberately minimal `extensions/maginalia` scaffold created under Decision D027 immediately before this benchmark. Decision D028 also requires a repository-wide purge of unnecessary legacy material from the active `MAGINALIA_IDE` tree.

Treat that reset as intentional. The removed Alpha 0.1 VS Code extension application layer is **historical evidence, not a compatibility target**.

Do not spend benchmark effort reconstructing old command IDs, tree views, Git/GitHub orchestration, Publish flows, Capture import UI, or preview webviews merely because they existed in Git history.

Preserve and reuse independent canonical assets such as portable format contracts, packages, overlay infrastructure, and Accepted decisions where relevant. Inspect deleted legacy extension code only to answer a specific evidence question.

The purpose of the reset is to give the Writing Core a clean product surface while keeping mature infrastructure underneath. Do not infer requirements from removed historical files or recreate material simply because an older commit contained it. Git history is evidence on demand, not part of the active specification.

---

# 4. Initial Repository Handoff

Before substantial implementation begins, delegate repository reconnaissance to Luna Max.

Have Luna Max produce or update a concise working document such as:

`BENCH_HANDOFF.md`

It should summarize:

1. Repository topology
2. Current executable/product state
3. Major components and responsibilities
4. Current user-visible flows
5. Architecture actually present in code
6. Known incomplete or broken areas
7. All `AGENTS.md` files, their scopes, and conflicts
8. Important ADR / Decision Log / specification inventory
9. Build, test, packaging, and development commands
10. High-risk technical debt
11. Files Astra genuinely needs to read directly
12. Questions that require architectural or product judgment

The report must be compact and evidence-oriented.

Ask Luna Max to identify a **small set of files** that deserve direct Astra attention rather than forwarding the whole repository.

As a default, Astra should work primarily from:

- this benchmark prompt,
- the MAGINALIA philosophy expressed below,
- `BENCH_HANDOFF.md`,
- relevant Accepted ADRs / Decision Log entries,
- a small number of exact source files required for decisions,
- Luna Max implementation reports,
- diffs,
- and verification results.

---

# 5. Research and Delegation Rule

You are not expected to already know every technical detail of the repository, framework, dependency, or implementation.

When you encounter something you do not know, do not guess and do not immediately spend Astra context researching it yourself.

Instead:

1. Identify the specific question whose answer is required.
2. Delegate that investigation to Luna Max.
3. Ask Luna Max to inspect the relevant repository files, documentation, history, implementation, or other available evidence.
4. Require a concise report containing:
   - the answer,
   - relevant evidence,
   - affected files or components,
   - important uncertainties,
   - and conflicting information if discovered.
5. Review the report yourself.
6. Inspect original source material directly only when exact details are necessary for a consequential decision.
7. Make the architectural, product, planning, or integration decision yourself.

Preferred pattern:

> **Astra asks → Luna Max investigates → Astra reviews → Astra decides.**

This applies especially to:

- unfamiliar repository structure,
- existing implementation behavior,
- framework capabilities,
- dependency behavior,
- build and test failures,
- historical architectural decisions,
- existing `AGENTS.md` instructions,
- unclear data contracts,
- implementation feasibility,
- and questions that can be established mechanically from evidence.

If Luna Max cannot answer confidently, use the reported uncertainty as evidence.

Do not force it to invent an answer.

---

# 6. Mission

Your mission is to understand MAGINALIA IDE as both a software system and a product, determine the most valuable achievable next state for the **MAGINALIA IDE Writing Core**, organize the work required to reach that state, and carry the repository toward that state as far as reasonably possible.

Do not stop at analysis or recommendations when implementation is possible.

The repository itself is the primary deliverable.

The final report is secondary.

---

# 7. MAGINALIA Philosophy

## 7.1 What MAGINALIA is

MAGINALIA is an environment for intellectual production.

It is not primarily:

- a programming IDE,
- a Markdown editor,
- a Git client,
- a citation manager,
- or a note-taking application.

It may use technologies from all of these categories, but it presents them as one coherent place for:

- reading,
- collecting,
- quoting,
- thinking,
- organizing,
- writing,
- revising,
- and publishing knowledge.

The central object is not the repository.

The central object is **the user's work**.

MAGINALIA exists to make sophisticated digital knowledge infrastructure usable by a person who does not know, and should not need to know, how that infrastructure works.

---

## 7.2 Beautifully simple outside, sophisticated inside

The governing rule is:

> **Simple outside. Complex inside.**

Internally MAGINALIA may use:

- Code-OSS-class IDE infrastructure,
- Git,
- GitHub,
- Markdown,
- YAML,
- JSON,
- indexes,
- search databases,
- parsers,
- rendering engines,
- filesystem conventions,
- extensions,
- background processes,
- or other sophisticated systems.

These are implementation details.

They must not become prerequisites for use.

A user should not need to understand:

- repositories,
- commits,
- branches,
- staging,
- merge conflicts,
- YAML,
- JSON,
- terminals,
- package managers,
- build systems,
- or programming terminology

in order to write, organize notes, insert a quotation, inspect an earlier version, or export a manuscript.

MAGINALIA may contain complex machinery.

It must not demand complex behavior from its user.

---

## 7.3 Git is infrastructure, not interface

MAGINALIA uses Git because intellectual work benefits from:

- history,
- reversibility,
- provenance,
- comparison,
- collaboration,
- and durable ownership.

But ordinary users should encounter concepts such as:

- History
- Previous version
- Restore
- Changes
- Publish
- Sync

rather than:

- commit
- checkout
- rebase
- stage
- pull request
- branch
- HEAD
- origin

Preserve the power of Git while removing Git literacy as an entrance requirement.

---

## 7.4 Files belong to the user

MAGINALIA must not turn a person's intellectual life into an opaque application database.

Durable source data should use open, inspectable formats wherever practical:

- Markdown,
- YAML,
- JSON,
- ordinary images and attachments,
- and Git history.

MAGINALIA is a view and operating environment over the user's information.

It is not the owner of that information.

A MAGINALIA project should remain intelligible outside MAGINALIA.

The user should be able to leave the software without leaving their writing behind.

---

## 7.5 The editor is the center

MAGINALIA IDE is fundamentally a place to write.

Capture, Shelf, Hive, and other ecosystem components may bring information into MAGINALIA or expose it elsewhere.

MAGINALIA IDE is where information becomes intellectual production.

The central surface is therefore the document editor.

The target experience should approach the immediacy and visual clarity of tools such as Typora or Notion while preserving Markdown as durable underlying text.

Ordinary writing should not feel like editing source code.

---

## 7.6 Semantic text and presentation are separate

A document has at least two different properties:

1. what the text means and how it is structured,
2. how it should look in a particular context.

Markdown represents the durable semantic document.

Presentation settings represent display and export behavior.

Users may control:

- horizontal or vertical writing,
- indentation,
- paragraph appearance,
- font size,
- paper size,
- lines per page,
- characters per line,
- manuscript-paper layout,
- and other publication-oriented settings

without corrupting the semantic Markdown with application-specific layout syntax.

Presentation may enrich the document.

It must not destroy portability.

---

## 7.7 Writing is structural editing

Long-form writing is not merely typing sentences.

The editor should also function as an outline processor.

Headings and sections are structural objects.

Users should be able to:

- see the outline,
- navigate by section,
- collapse and expand sections,
- reorder sections,
- promote heading levels,
- demote heading levels,
- and understand the shape of long documents.

The outline and document are two views of the same semantic text.

---

## 7.8 Quotations are first-class material

For humanities-oriented intellectual work, quotations are working material.

MAGINALIA therefore treats quotations, annotations, memos, and their sources as first-class objects.

The user should be able to maintain a library of material gathered from:

- books,
- articles,
- documents,
- web sources,
- manually entered text,
- and MAGINALIA Quote Capture.

The library should support:

- browsing,
- indexing,
- filtering,
- source relationships,
- metadata,
- full-text search,
- and insertion into writing.

A quotation should preserve enough provenance that the user can later understand where it came from.

---

## 7.9 Retrieval belongs inside writing

The quotation library must not live only in a distant management screen.

While editing:

> **Ctrl+Q opens quotation search.**

The user can search by quotation text, author, title, source metadata, tag, memo, or other useful indexed fields.

The intended interaction is approximately:

1. press `Ctrl+Q`,
2. type a query,
3. inspect matching quotations and source information,
4. select one,
5. insert it at the cursor,
6. continue writing.

The distance between remembering a source and using it should approach zero.

---

## 7.10 MAGINALIA is a shell

MAGINALIA should reuse mature underlying systems rather than recreate them unnecessarily.

The goal is not to reimplement:

- a text engine,
- a desktop shell,
- Git,
- filesystem operations,
- every export converter,
- or every editor primitive

from first principles.

Use mature infrastructure.

Hide accidental complexity.

Build the MAGINALIA experience above it.

A Code-OSS-class desktop IDE foundation is appropriate because it already provides mature:

- workspace infrastructure,
- file operations,
- editor lifecycle,
- commands,
- extension mechanisms,
- desktop integration,
- and other foundational capabilities.

But the finished MAGINALIA application must not feel like a reskinned programming IDE.

MAGINALIA is not:

> VS Code with some buttons removed.

It is:

> a writing and knowledge environment that reuses industrial IDE machinery underneath.

Anything inherited from the underlying framework must justify its presence in the MAGINALIA user experience.

---

## 7.11 Hide what the user does not need

Normal MAGINALIA UI should not expose functionality merely because the underlying framework has it.

Developer-facing concepts such as:

- terminals,
- debuggers,
- source control panels,
- extension development,
- raw configuration,
- programming language tooling,
- internal logs,
- developer command surfaces

should not occupy the ordinary product interface.

The primary user-facing concepts should be understandable without technical documentation:

- Documents
- Project Contents
- Library
- Search
- Outline
- History
- Export

The default product surface remains deliberately small.

---

## 7.12 One environment, not a pile of plugins

Editor, Library, Search, History, project navigation, and Export should not feel like unrelated extensions bolted onto an IDE.

They should share:

- navigation,
- visual language,
- keyboard behavior,
- terminology,
- state,
- and data relationships.

Technical modularity is desirable internally.

Product fragmentation is not.

---

## 7.13 Relationship to the MAGINALIA ecosystem

### MAGINALIA Quote Capture

Capture brings material from the physical or external world into the system, including books, ISBN metadata, photographed pages, OCR text, quotations, and annotations.

### MAGINALIA Shelf

Shelf presents collected books, quotations, and related material in a library-oriented form.

### MAGINALIA IDE

MAGINALIA IDE is the center of intellectual production.

This is where users:

- write,
- organize,
- search,
- quote,
- revise,
- structure,
- connect,
- and prepare work for publication.

### MAGINALIA Hive

Hive is the broader discovery and indexing layer for published or shared MAGINALIA-compatible information.

These products may share formats and contracts.

They should not become one monolithic implementation merely because they belong to one ecosystem.

---

## 7.14 Start simple, divide and conquer, use mature tools

MAGINALIA engineering follows:

- start simple,
- divide and conquer,
- 餅は餅屋,
- use mature tools for mature problems,
- keep interfaces explicit,
- make durable data more important than temporary application state,
- build coherent vertical slices before expanding the system.

Complexity is acceptable when it buys capability.

Complexity without user value is not.

---

# 8. Benchmark Product: MAGINALIA IDE Writing Core

Do **not** attempt to build the entire future MAGINALIA ecosystem.

The benchmark target is the first coherent usable core of MAGINALIA IDE.

It should demonstrate the philosophy through a real working desktop application.

Prefer a small number of polished, integrated workflows over a large number of disconnected partial features.

---

# 9. Application Shell

Reuse the repository's existing mature IDE-derived foundation wherever practical.

Do not replace mature framework capabilities without strong reason.

The finished ordinary interface should remove, replace, wrap, or conceal programming-oriented surfaces irrelevant to MAGINALIA users.

The primary product-level navigation should center on concepts such as:

- Documents
- Library
- Search
- History

The editor is the main workspace.

Do not expose normal users to raw Git operations, terminals, debugger controls, developer tooling, repository terminology, or framework-specific implementation concepts.

---

# 10. Document Model

A MAGINALIA **Document is not internally a single Markdown file**.

Each Document is internally its own **project folder**.

From the user's perspective, a Document may correspond to:

- a paper,
- essay,
- novel,
- report,
- research project,
- manuscript,
- or another coherent unit of intellectual work.

From the system's perspective, that Document is a directory containing the files and resources that belong to the work.

A Document may contain:

- one or more Markdown files,
- images,
- reference material,
- attachments,
- metadata,
- presentation profiles,
- project-specific data,
- and other ordinary files required by the work.

The project folder is the durable ownership boundary.

A user should be able to inspect that folder outside MAGINALIA and find an intelligible collection of ordinary files.

---

# 11. Documents and Project Contents

The **Documents** surface is the MAGINALIA interpretation of the underlying IDE workspace/project model.

Each Document opens as a project.

Within a Document, MAGINALIA exposes **Project Contents**.

Internally, Project Contents may and should reuse the mature capabilities of the underlying Explorer/file-workspace infrastructure.

Required capabilities include:

- viewing files and folders,
- creating files,
- creating folders,
- renaming,
- moving,
- deleting,
- opening files,
- organizing related assets,
- drag-and-drop where practical,
- and other mature file-management behavior already available from the framework.

However, do not expose it as a programmer-oriented source tree.

The user should understand it as:

> the contents of this work

not:

> the files in this repository.

Preserve filesystem power.

Translate the mental model.

---

# 12. Distinct Navigation Levels

Keep these concepts distinct:

### Documents

**Which intellectual work am I working on?**

### Project Contents

**What files and resources belong to this work?**

### Outline

**How is the currently edited text structured?**

Do not collapse these into one ambiguous navigation system.

Internally they may reuse related IDE primitives.

Externally they answer different human questions.

---

# 13. Rich Visual Markdown Editor

Implement a high-quality visual Markdown writing experience.

Target interaction quality closer to Typora or Notion than to a source-code editor.

Required capabilities include:

- visually rich Markdown editing,
- headings,
- paragraphs,
- emphasis,
- lists,
- quotations,
- links,
- code where appropriate,
- keyboard shortcuts,
- undo and redo,
- readable typography,
- minimal visual distraction,
- vertical writing,
- configurable paragraph indentation,
- and integration with the outline processor.

Markdown remains the durable source representation.

The user should normally edit readable rendered text rather than raw Markdown syntax.

A project may contain multiple Markdown files.

The editor must behave coherently in that environment.

---

# 14. Outline Processor

For the currently edited Markdown file, provide a semantic outline.

Required behavior should include:

- viewing headings,
- jumping to sections,
- collapsing and expanding sections,
- moving sections,
- promoting headings,
- demoting headings.

Section reordering should alter the underlying document structure correctly rather than creating a disconnected outline database.

The outline is another view of the same document.

---

# 15. Invisible Git History

Use Git internally for project history where consistent with current architecture.

Normal editing should produce recoverable history without requiring Git knowledge.

Provide a human-oriented History experience capable of at least:

- showing previous states,
- showing when changes occurred,
- previewing meaningful changes,
- restoring an earlier version.

History may cover the entire Document project, not only the currently open file.

Do not expose normal Git terminology unless absolutely required in an advanced or diagnostic context.

Prefer:

- History
- Previous version
- Restore this version
- Changes

over:

- Git log
- checkout
- commit
- diff
- branch

Git is machinery.

History is the product feature.

---

# 16. Quote and Memo Library

Provide a first-class Library surface.

The implementation should support storage, browsing, indexing, and search for:

- sources,
- quotations,
- memos,
- annotations,
- and relevant metadata.

Where current MAGINALIA contracts already define source and annotation structures, preserve compatibility rather than inventing competing schemas.

The Library should be able to consume MAGINALIA-compatible data produced externally, including future or existing Quote Capture flows.

Do not unnecessarily duplicate data into each Document project merely to make it searchable.

Respect current canonical data contracts where they exist.

---

# 16.5 Existing Shelf Web UI Reference

Do not invent the Library/Shelf interaction from a blank page.

A working prototype already exists in the sibling repository `potoha/MY_marginallia`, primarily in the loopback PC reviewer Web UI.

Ask Luna Max to inspect, at minimum:

- `APK/reviewer/src/marginalia_reviewer/ui.py`
- `APK/reviewer/src/marginalia_reviewer/db.py`
- `APK/reviewer/README.md`
- `APK/docs/REVIEW_LIBRARY_V1_PROGRESS.md`

Treat this implementation as a **product and interaction reference**, not as an architecture mandate.

Useful existing behaviors include:

- reviewed-quotation search,
- literal Japanese-friendly substring matching,
- search across quote text, comment, book title, authors, and page label,
- filtering by book / ISBN / review state,
- quote-first result cards,
- source metadata adjacent to the quotation,
- memo/comment display,
- copy-quotation action,
- reopening the underlying reviewed item,
- empty/loading/error states,
- and a local-first workflow that does not require a remote search service.

The benchmark should preserve or improve the successful user interaction where it fits the Writing Core, especially the short path from remembering a quotation to using it.

Do **not** automatically inherit:

- the FastAPI loopback architecture,
- SQLite as MAGINALIA IDE's durable source of truth,
- NDLOCR responsibilities,
- Capture review responsibilities,
- GitHub publication UI,
- legacy publication contracts,
- or reviewer-specific state machines.

The IDE Library must remain consistent with MAGINALIA's current portable-data contracts and product boundaries.

Astra should ask Luna Max to extract the reusable interaction model and implementation lessons, then decide how the Writing Core should realize them inside Code-OSS.

---

# 17. Ctrl+Q Quote Search and Insertion

This is one of the benchmark's highest-priority acceptance criteria.

While editing:

1. press `Ctrl+Q`,
2. show a lightweight quotation search / insertion window,
3. search the local quote library,
4. show useful source information with results,
5. select a quotation,
6. insert it at the current cursor position,
7. preserve the relationship to its source where supported by the data model,
8. close the search UI,
9. continue writing immediately.

The user should not need to leave the document.

The interaction should feel like a native part of writing, not a separate citation-manager workflow.

---

# 18. Export System

Implement an export architecture capable of turning semantic document content into publication-oriented output.

Required output formats:

- PDF
- DOCX
- HTML

Required configurable presentation options:

- font size in points,
- paper size,
- horizontal or vertical writing,
- characters per line,
- lines per page,
- paragraph indentation,
- manuscript-paper mode.

Formatting configuration must remain conceptually and structurally separate from the semantic Markdown.

Do not create a proprietary Markdown dialect merely to encode layout.

Presentation profiles may live as documented project metadata/configuration.

When practical, use a shared intermediate rendering model so PDF, DOCX, and HTML do not become unrelated formatting implementations.

The architecture should leave room for multi-file projects to define which files and ordering constitute an exportable manuscript, without requiring a complete publishing system in this benchmark.

---

# 19. Framework Reuse Rule

Do not reimplement mature capabilities from first principles when the underlying framework already provides them reliably.

Examples include:

- file watching,
- filesystem operations,
- editor lifecycle,
- command routing,
- project/workspace management,
- explorer primitives,
- undo/redo infrastructure,
- keyboard dispatch,
- windowing,
- and standard desktop integration.

Reuse the machinery.

Replace, wrap, translate, or hide programmer-oriented presentation.

MAGINALIA's engineering task is not to rebuild the industrial base.

It is to make that base useful to people who should never have to understand it.

---

# 20. Explicit Non-Goals

Do not expand this benchmark into the entire MAGINALIA roadmap.

The following are not required unless existing implementation makes them essentially free and they directly help the Writing Core:

- Capture camera implementation,
- OCR implementation,
- ISBN scanning,
- openBD integration,
- Hive,
- social/public sharing features,
- complete GitHub collaboration,
- mobile applications,
- AI writing assistants,
- plugin marketplaces,
- programming IDE functionality,
- full reference-manager functionality,
- every citation style,
- every publishing workflow,
- speculative future infrastructure.

Prepare compatibility boundaries where useful.

Do not build the future merely because it is imaginable.

---

# 21. Autonomy and Decision Policy

Bias toward action and completion.

Infer routine implementation details from:

- this prompt,
- accepted architecture,
- current repository evidence,
- existing conventions,
- and technical judgment.

Do not ask the user to decide ordinary engineering questions you can resolve yourself.

Before asking the user a question:

1. determine whether Luna Max can answer it from repository evidence,
2. delegate the investigation if so,
3. make the decision yourself if it is an implementation or architectural judgment you can responsibly make.

Ask the user only when a decision:

- is genuinely consequential,
- cannot reasonably be inferred,
- cannot be resolved through repository evidence,
- and materially changes the intended product rather than merely its implementation.

If an unresolved question blocks only one part of the work, continue independent work elsewhere.

---

# 22. Planning

Maintain a short working plan.

Do not spend a large portion of the benchmark producing an exhaustive speculative roadmap.

Plans exist to guide execution.

They are not the deliverable.

At each major checkpoint:

1. review what has actually been learned,
2. revise the plan if necessary,
3. choose the next highest-value coherent unit of work,
4. delegate implementation or investigation,
5. review the result,
6. continue.

Prefer coherent vertical progress over disconnected horizontal scaffolding.

---

# 23. Luna Max Delegation Strategy

Use Luna Max aggressively but intelligently.

Luna Max should normally perform the bulk of:

- repository reconnaissance,
- file tracing,
- localized code changes,
- straightforward feature implementation,
- mechanical refactors,
- test implementation,
- build-error investigation,
- documentation updates,
- repetitive cleanup,
- and bounded technical research.

Astra should retain responsibility for:

- product interpretation,
- architecture,
- decomposition,
- prioritization,
- ambiguous decisions,
- cross-component reasoning,
- evaluation of alternatives,
- acceptance criteria,
- review,
- integration,
- and deciding the next work package.

For every delegated work package, provide enough information for correct execution:

- goal,
- relevant context,
- relevant paths,
- constraints,
- non-goals,
- acceptance criteria,
- tests or verification required,
- and what must be reported back.

Do not dump the entire project context into every Luna Max conversation.

Give the minimum context necessary plus references to authoritative repository files.

---

# 24. Delegation Loop

Use this operating loop:

1. Understand enough of the current state to identify the next meaningful problem.
2. Define a bounded objective.
3. Delegate investigation or implementation to Luna Max.
4. Receive the report, diff, or result.
5. Review it.
6. Decide whether to:
   - accept,
   - revise,
   - request correction,
   - reject,
   - integrate,
   - or change direction.
7. Select the next highest-value task.
8. Repeat.

Do not simply issue many tasks and treat their outputs as automatically correct.

Actively supervise them.

---

# 25. Review and Integration

Treat delegated implementation as untrusted until reviewed.

A build passing is not sufficient.

Tests passing are not sufficient.

For significant delegated work, review it against:

- the original objective,
- MAGINALIA philosophy,
- architectural boundaries,
- repository conventions,
- maintainability,
- user simplicity,
- unnecessary complexity,
- regressions,
- data ownership and portability,
- and acceptance criteria.

If Luna Max produces technically functional code that conflicts with MAGINALIA's architecture or philosophy, reject or revise it.

When problems are localized, prefer delegating corrections rather than spending Astra tokens rewriting implementation yourself.

---

# 26. Verification

Verification should be proportional to the consequences of the change.

Run existing relevant tests and required project checks.

Add tests where they protect:

- meaningful behavior,
- public contracts,
- regressions,
- non-obvious logic,
- or critical user flows.

Do not create redundant tests merely to increase test count.

When possible, verify behavior at the level a real user or downstream component experiences it.

For this benchmark, prioritize verification of integrated workflows such as:

- opening a Document project,
- managing Project Contents,
- editing Markdown visually,
- using the outline,
- using Ctrl+Q to search and insert a quotation,
- inspecting/restoring History,
- exporting output.

When checks fail, determine whether the cause is:

- your implementation,
- a delegated implementation,
- the test,
- the environment,
- or a pre-existing repository problem.

Do not hide pre-existing failures.

Do not misattribute them.

---

# 27. Token and Context Discipline

Astra's reasoning budget is part of the benchmark.

Use it deliberately.

Prefer:

- targeted questions over broad repo reading,
- Luna Max investigation over mechanical Astra archaeology,
- concise evidence reports over full transcripts,
- diffs over whole files when appropriate,
- durable repository documents over repeatedly restating context,
- decisions based on evidence over prolonged speculation,
- iterative planning over one enormous plan.

Do not repeatedly re-derive decisions already established.

Record important architectural decisions durably when doing so prevents future ambiguity.

Do not optimize for minimum token consumption at the expense of correctness.

Optimize for:

> **useful engineering progress per Astra token**

---

# 28. User Acceptance Scenario

The benchmark should aim to make the following workflow meaningfully functional.

A person with essentially no programming knowledge launches MAGINALIA.

They see their **Documents**.

They create a new Document for a paper, manuscript, novel, or research project.

Internally MAGINALIA creates or opens a project folder.

The user does not need to understand that.

Inside the Document they can organize:

- manuscript files,
- images,
- notes,
- references,
- and related resources

through **Project Contents**.

They create or open a Markdown file.

They write using a visual editor rather than a programmer-style source editor.

They organize a long text using the outline.

They can use vertical writing and appropriate visual typography when desired.

They open the Library and find previously stored quotations and notes.

While writing, they remember a quotation.

They press:

`Ctrl+Q`

They search.

They select a quotation.

It appears at the cursor.

They continue writing immediately.

MAGINALIA preserves project history using Git underneath.

The user opens History, sees earlier states, and can restore one without learning Git.

Finally, they choose an export profile and produce PDF, DOCX, or HTML with publication-oriented options such as:

- font point size,
- paper size,
- line count,
- character count,
- vertical writing,
- indentation,
- or manuscript-paper layout.

At no point should this workflow require the user to understand:

- Code-OSS,
- Git,
- repository internals,
- Markdown parser implementation,
- search indexing internals,
- rendering engines,
- or other developer infrastructure.

But if they inspect their project outside MAGINALIA, their work remains ordinary, intelligible files.

That distinction is fundamental.

---

# 29. Product Quality Rule

A function technically existing is not sufficient.

Prefer four polished, integrated workflows over twenty exposed framework features.

Every user-facing implementation decision should be tested against this question:

> **Would a humanities student, researcher, writer, or other person who knows essentially nothing about computers understand what to do next?**

If the answer is no, the technical functionality is not yet a MAGINALIA feature.

It is only machinery.

---

# 30. Completion and Stop Conditions

Do not stop merely because:

- you produced a plan,
- repository reconnaissance completed,
- one delegated task completed,
- one component works,
- a convenient checkpoint was reached,
- the task is larger than expected,
- or more evidence is required.

Continue the:

> **plan → delegate → review → integrate**

cycle while useful, safe, in-scope work remains possible.

Stop when one of the following is true:

- the selected coherent objective has been completed and verified,
- additional work would no longer improve the Writing Core meaningfully,
- further work requires a genuinely consequential user decision,
- further work depends on unavailable external access or information,
- or continuing would require violating the product philosophy or current authoritative constraints.

---

# 31. Final Report

At completion, provide a concise engineering report containing:

- your understanding of MAGINALIA,
- the architectural interpretation you used,
- what coherent objective you selected and why,
- how you divided work between Astra and Luna Max,
- major changes made,
- important architectural decisions,
- delegated work that was accepted, revised, or rejected,
- tests and verification performed,
- unresolved problems,
- important uncertainties,
- assumptions that materially affected implementation,
- and the most valuable next step.

Clearly distinguish:

- completed work,
- partially completed work,
- blocked work,
- and recommendations.

Do not provide a blow-by-blow transcript of Luna Max conversations.

The repository is the primary deliverable.

---

# 32. Begin

Start by preserving Astra context.

Do not broadly read the repository yourself.

First decide what repository understanding you need.

Delegate the initial repository reconnaissance and `AGENTS.md` inventory to Luna Max.

Review the resulting compressed evidence.

Then choose the highest-value coherent vertical slice that advances the MAGINALIA IDE Writing Core.

Plan it.

Delegate implementation.

Review it.

Integrate it.

Continue as far as you can.

**This is a benchmark. Show the full extent of GPT-6 Astra's engineering judgment, orchestration ability, and capacity to turn MAGINALIA's philosophy into working software.**
