# MAGINALIA Instant Memory

This directory is a **retrieval-oriented external memory layer** for OpenCode.

It is not a single always-loaded summary file.

The memory system is designed to answer:

> For this specific task, which small pieces of project context are worth putting into the model context window?

## How it works

```text
task / prompt
  ↓
short retrieval query
  ↓
memory/index.json
  ↓
score tags + keywords + path hints + active status
  ↓
top relevant records only
  ↓
agent context
  ↓
canonical repository sources when needed
```

The index is cheap to read every session.
The records are loaded selectively.

## Files

- `index.json` — structured registry of memory records.
- `query.mjs` — deterministic lightweight retriever.
- `records/*.md` — small topic-specific memory records.

## Retrieval rule

Default:
- retrieve at most 5 records;
- prefer active records;
- use task terms, slice names, component names, and touched paths;
- load a canonical source only when the memory record points to it and the task requires current truth.

Do not recursively read every record.

## Memory record role

A memory record may contain:
- current state;
- durable invariants;
- settled product decisions;
- active debt;
- recovery instructions;
- canonical source pointers;
- retrieval tags/keywords.

A record must not pretend to be canonical specification.

When memory conflicts with:
1. latest Product Owner instruction,
2. accepted MAGINALIA_IDE decisions/plans,
3. current source/tests/Git evidence,

the memory loses.

## Updating memory

Update or add a record when:
- an active slice changes;
- a durable architectural invariant changes;
- a significant debt item is created/resolved;
- roadmap order changes;
- execution-runtime policy changes.

Avoid session diaries and long chronological logs.

Detailed history belongs in Git, plans, ADRs, and Implementation Handoff Reports.
