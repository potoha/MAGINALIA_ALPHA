# OSS Governance and Licensing Plan

Status: planning policy  
Date: 2026-08-16

MAGINALIA は OSS を「無料版」ではなく、研究データの可搬性と道具の交換可能性を支える本流として扱います。

---

# 1. Current repository license snapshot

As observed on 2026-08-16:

| Repository | Current visibility | Code license state |
|---|---|---|
| `MAGINALIA_IDE` | private | MIT + NOTICE / brand exclusion |
| `Uttate-writer` | public | Apache-2.0 + NOTICE |
| `MY_marginallia` | private | no top-level project license identified in current root audit |
| `toybox` | private | planning/second-brain repository, not a distribution target |

Do not assume that public visibility alone grants reuse rights. `MY_marginallia` needs an explicit license decision before an OSS public release.

---

# 2. License goals

The license system should answer four different questions separately.

## A. MAGINALIA-owned source code

Can people use, modify, redistribute, and build on the code?

## B. Upstream / third-party source

What attribution and redistribution terms come from Code-OSS and dependencies?

## C. Brand assets

Can a fork call itself MAGINALIA or reuse logos?

## D. User research data

Who owns project content, quotations, notes, images, and generated outputs?

These are not the same license question.

---

# 3. Code license policy

Do not trigger a cross-repository relicensing project during α1 unless a concrete incompatibility exists.

Current practical approach:

- keep `MAGINALIA_IDE` MIT unless a later ADR changes it
- keep `Uttate-writer` Apache-2.0 unless a later ADR changes it
- choose and add an explicit OSS license to `MY_marginallia` before public OSS release
- keep third-party notices accurate

A shared contract/schema may need an intentionally permissive license to encourage third-party implementations. Decide this explicitly before Format v1 is advertised as an ecosystem standard.

---

# 4. Brand boundary

Code freedom and brand identity are separate.

MAGINALIA name, logo, product marks, and official distribution identity may be reserved even when source code is permissively licensed.

Fork policy should eventually state:

- source may be forked under its code license
- official MAGINALIA name/logo are not automatically licensed for a confusingly identical fork
- compatibility claims should refer to contract versions, not imply official endorsement

Example:

```text
Compatible with Annotation v1
```

is preferable to an uncontrolled claim of being an official MAGINALIA product.

---

# 5. User data policy

User project content remains user-controlled data.

MAGINALIA code licenses do not claim ownership over:

- notes
- manuscripts
- quotations
- source metadata created/edited by users
- captured images
- research project repositories
- Writer personal dictionaries/profiles

Public publishing is an explicit user action and may involve copyright constraints outside software licensing.

The application should not silently attach an OSS code license to user content.

---

# 6. Contribution model for early OSS

Start simple.

Before a large community exists:

- GitHub Issues / Discussions as appropriate
- pull requests
- CONTRIBUTING.md
- code of conduct decision before broad community launch
- clear test commands
- architecture links
- `good first issue` only where boundaries are stable

Do not introduce a heavy CLA process before there is a legal/business need.

A DCO/CLA decision can be revisited before institutional/commercial scale.

---

# 7. Maintainer authority

For α/β stage, repository maintainers decide:

- contract compatibility
- security/privacy boundaries
- release acceptance
- official distribution
- brand use in the official repo

External contributors should be able to implement adapters without requiring approval for every internal design preference, provided they satisfy the documented interface and tests.

---

# 8. Extension ecosystem principle

Third-party extensions/adapters should be able to add value without forking the entire IDE.

Good extension targets:

- bibliography providers
- OCR providers
- repository providers
- renderers/exporters
- importers
- language/CJK support

α1 does not require a new plugin marketplace or dynamic plugin loader.

Use existing VS Code extension mechanisms and documented interfaces first.

---

# 9. Third-party dependency policy

Before release:

- lock dependencies
- generate/maintain third-party notices where required
- avoid dependencies with unclear redistribution terms
- do not copy third-party code without preserving license/notice requirements
- review packaged binaries/models separately from source dependencies

AI model weights are especially separate assets and need their own license analysis.

---

# 10. Official Writer Model boundary

Future official model weights are not automatically covered by the Writer client's Apache-2.0 license.

Keep separate:

```text
Writer client code
Writer provider adapters
training scripts/dataset tooling
official model weights
training datasets
```

Each may have different redistribution/privacy/legal constraints.

Model commercialization must not make the OSS Writer client unable to use alternative local/provider implementations.

---

# 11. Format governance

Once third parties depend on Marginalia Format v1:

- breaking changes require an ADR
- migration path required
- schema/fixtures public
- supported versions documented
- extension namespace policy documented
- deprecation period documented

The Format should not change merely to match one current UI implementation.

---

# 12. Release before public-open checklist

Before turning a currently private product repo into a public OSS release:

- [ ] explicit LICENSE exists
- [ ] NOTICE / third-party notices reviewed
- [ ] secrets and private test data scan
- [ ] sample data is redistributable
- [ ] brand boundary stated
- [ ] README distinguishes users/contributors
- [ ] SECURITY.md / vulnerability contact exists
- [ ] contribution instructions exist
- [ ] build is reproducible enough for contributors
- [ ] issue templates do not request sensitive research data

---

# 13. Business boundary

The OSS product should remain genuinely useful.

Potential paid/official value may live in:

- signed official distribution
- support / setup
- institutional deployment
- official model assets
- managed provider convenience
- future hosted index/service

Do not create artificial file-format, export, or basic interoperability limitations to force subscription.
