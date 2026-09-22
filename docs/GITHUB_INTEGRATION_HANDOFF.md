# GitHub / Online Storage Integration Handoff

Status: product handoff / implementation guidance  
Updated: 2026-09-22  
Target repository: `MAGINALIA_ALPHA`  
Scope: Repository Core cloud wiring, user-facing online storage, History UI, and future collaboration / Issues direction

---

## 1. Product intent

MAGINALIA must not teach Git or GitHub in order to provide online storage.

For the normal user, the mental model is:

- work locally
- save normally
- optionally save the work online
- view History
- open work on another machine
- later, share / collaborate / discuss work

Git, repositories, branches, commits, remotes, tokens, fetch, push, and provider-specific details are implementation infrastructure.

The product should learn from the Microsoft Word / OneDrive interaction model:

- cloud storage is presented as a save location / capability, not as version-control training
- account connection belongs in first-run guidance and settings
- moving a local document online is an explicit user action
- sharing and History become document/project capabilities after online storage exists
- version history is a user-facing pane, not a Git log

This is UX inspiration only. MAGINALIA keeps its own local-first, non-destructive Repository Core contracts and does not inherit Word's exact synchronization semantics.

---

## 2. Terminology

### User-facing repository kinds

Use:

- Project
- Workdesk
- Private Shelf

`Workbench` is no longer the normal user-facing term.

### Compatibility boundary

The current portable Repository Core v1 contract still uses:

`kind: "workbench"`

for compatibility.

Do not silently rewrite existing portable identities merely to rename the user-facing concept. A durable `workdesk` kind requires an explicit schema/template migration.

User-facing UI and new product documentation should say **Workdesk** unless discussing the v1 technical compatibility contract.

---

## 3. Stable baseline already present

The stable local baseline is already substantial:

- local-first Project / Workdesk-compatible Workbench / Private Shelf creation
- portable `.maginalia/repository.json` identity
- ordinary authored files as the source of truth
- local Git-backed History
- fresh-copy History viewing
- incomplete-copy marker and validation
- Project / Workdesk writing flow
- Private Shelf Library flow
- local operation without GitHub
- **Save != cloud synchronization**

Do not reimplement these as a second storage system.

---

## 4. Current cloud implementation status

As of this handoff, the cloud side is not product-complete.

Existing Electron-side components include:

- GitHub App Device Flow authentication
- private-work discovery
- verified-private GitHub remote handling
- pending cloud-creation ledger
- private provisioning components
- connection metadata
- Git fetch / probe / push primitives
- Sync relationship classification
- renderer transient cloud state components
- partial main-process cloud coordinator
- focused tests around these boundaries

However, these pieces are not yet one complete normal-user flow.

The normal renderer does not yet expose a finished product route equivalent to:

`Start Guide / Online Save -> authenticate -> create or select private storage -> verify -> initial Sync -> later Sync / Restore`

Live GitHub acceptance has not established the full product behavior.

The existing freeze rules remain important: do not mistake tested components for a completed online-storage feature.

---

## 5. Normal user model

### Local work is always valid

A user can create and use MAGINALIA locally without a GitHub account.

GitHub failure, authentication failure, network failure, provider outage, or remote inconsistency must not block normal local writing.

### Save remains local

Normal document Save / Autosave remains a local writing operation.

It must not depend on GitHub.

### "オンラインに保存" is the normal cloud action

The normal UI should expose a user-facing action:

**オンラインに保存**

The user should not be asked to perform or understand a Git operation.

Internally, this action may perform the Repository Core sequence:

1. confirm the local authored state is safe/saved
2. record the required local History snapshot
3. ensure an online-storage connection exists
4. provision or resolve the private remote if needed
5. verify provider identity and privacy
6. synchronize using the non-destructive Repository Core policy
7. report an understandable user-facing result

The implementation must preserve the distinction between local Save and remote Sync even if the normal UI uses the broader phrase "オンラインに保存".

### Future provider choice

The product surface should not permanently hard-code GitHub as the conceptual meaning of "online".

For the current implementation, GitHub is the supported provider.

The "オンラインに保存" flow should be shaped so that a future version can offer a provider choice without redesigning the entire user flow.

Provider selection is a future capability, not a requirement to build a multi-provider backend now.

---

## 6. Start Guide / first-run GitHub connection

GitHub connection belongs in the MAGINALIA Start Guide shown during installation / first run.

The Start Guide should explain the feature in user language, for example:

- connect an online storage account
- keep Project / Workdesk / Shelf available across machines
- continue locally if skipped

The guide may offer GitHub connection during setup, but skipping it must remain valid.

Normal users must not be asked for:

- Personal Access Token
- OAuth scope strings
- Client ID
- repository owner
- repository name
- branch name
- remote URL

Provider / permission details remain available in informed-consent or Advanced surfaces.

The existing GitHub App Device Flow is the intended desktop authentication foundation unless a later accepted decision replaces it.

---

## 7. Online storage provisioning

When a MAGINALIA work item is saved online for the first time:

- MAGINALIA should create or resolve the corresponding private remote
- MAGINALIA-created remote storage must be private
- there is no public fallback
- the provider repository must be independently reverified before transport
- the human title must remain separate from the technical storage name
- credentials must never be written into portable project data

The user should not have to create a GitHub repository manually.

### Idempotency

Remote creation must be recoverable and idempotent.

The product must not create duplicate repositories because a request succeeded remotely but the client lost the response.

Preserve the current invariant:

> one portable identity = one unresolved cloud intent

Malformed or ambiguous pending state must fail closed rather than guessing or issuing another create operation.

---

## 8. Online synchronization safety

Cloud synchronization must preserve the accepted Repository Core safety model.

Required behavior:

- checkpoint local saved work before remote mutation
- no force push
- no destructive reset
- no automatic merge into the active worktree
- no conflict-marker insertion into authored Markdown
- no silent overwrite of local work
- no silent substitution of a different remote
- verify the resulting remote head before reporting success

If remote work is ahead or histories diverge:

- keep the active local worktree untouched
- materialize the other state as a separate recovery / comparison copy
- deduplicate repeated recovery for the same identity + local head + remote head
- do not create a new recovery copy every time the same unresolved divergence is observed

---

## 9. Restore / opening work on another machine

"Open online work" is a product operation, not a clone tutorial.

The user should see MAGINALIA works, not a list of arbitrary Git repositories.

Restore / opening from online storage must:

- discover verified private MAGINALIA storage
- read portable identity
- skip unrelated repositories
- restore into a fresh local copy
- write the incomplete marker before materializing authored contents
- validate the candidate before normal entry
- never overwrite an active worktree

---

## 10. Workbench shell: History Viewer

Add a dedicated **History** view to the left activity column / primary sidebar model.

History must no longer be conceptually buried inside a generic Repository panel.

The History Viewer should present History in user terms:

- saved versions
- time
- meaningful label / summary when available
- current version indication
- changed-state indication
- open/view a historical version
- compare versions
- restore/open as a safe fresh copy according to Repository Core rules

Raw commit SHA, branch details, and Git terminology belong in Advanced details, not the default viewer.

The current renderer already has an activity bar + primary/secondary sidebar view system. History should become a first-class view in that system.

The current local History implementation is an asset to reuse. This task is primarily a product-view and orchestration change, not permission to invent a second History database.

---

## 11. Future collaboration direction

Collaboration is a future layer on top of the same Project / Workdesk / online-storage model.

Do not require users to learn branching in order to collaborate.

### Opening another person's Project

A future MAGINALIA user should be able to open another person's shared Project from the product UI.

When the user opens another person's Project for editing:

- preserve the original/default branch as the shared baseline
- automatically create an appropriate working branch for that user/session
- open the local working copy on that branch
- do not ask the normal user to choose or name a branch

The exact fallback when the user lacks permission to create a branch in the source repository is not fixed by this handoff and requires a later collaboration design decision.

Do not silently introduce destructive writes to the owner's baseline branch.

### Collaboration is not yet real-time co-authoring

This direction does not authorize a CRDT/OT real-time editor, central collaboration backend, or Word-style simultaneous cursor presence in the current slice.

Git-backed asynchronous collaboration is the first intended collaboration model.

---

## 12. Future Issue integration

GitHub Issues should eventually be exposed as a MAGINALIA discussion/task capability rather than as a developer-only GitHub surface.

### Context-menu Issue creation

A future context menu should allow the user to create an Issue from relevant context, such as:

- selected text
- current document
- quotation / reference
- Project item
- review finding

The UI action should say **Issueを作成** or equivalent user-facing wording.

The implementation may create a GitHub Issue under the hood for a connected Project.

Do not expose raw API or repository mechanics in the normal creation flow.

The Issue should preserve enough context to return from the discussion to the relevant MAGINALIA material. The exact durable anchor format requires a separate design before implementation.

### Issue Viewer

When Issue support is introduced, add an **Issues** view to the left activity column / primary sidebar model.

The Issue Viewer should support the normal project workflow, including at minimum:

- open / closed state
- title
- author
- labels when useful
- assignee when useful
- discussion / comments
- opening the referenced MAGINALIA context where possible

A connected Project with no Issues may show an empty state.

GitHub's web UI remains an Advanced escape hatch, not the primary normal-user Issue experience.

---

## 13. Target left-side information architecture

The Workbench activity model should evolve toward first-class views such as:

- Project / Workdesk
- History
- Issues, when Issue support is available

Shelf remains a separate research/reference surface and may continue to use the secondary sidebar where appropriate.

The activity bar is a product navigation surface, not a list of infrastructure adapters.

Do not add a generic "Git" view for normal users.

---

## 14. Word-inspired interaction rules

Use the following Word / OneDrive lessons as product guidance:

### Adopt

- account connection during start guidance rather than developer setup
- local-to-online transition as a save-location action
- online storage status expressed in user language
- History as a document/project feature
- sharing as a document/project action
- comments/discussion attached to working context
- provider details secondary to the user's work

### Do not copy blindly

- do not make online storage mandatory
- do not collapse local Save and cloud synchronization at the implementation boundary
- do not auto-upload without an explicit product decision
- do not overwrite divergent work merely to simulate seamless co-authoring
- do not build a central research-data backend just to imitate OneDrive

---

## 15. Security and privacy invariants

Preserve all of the following:

- MAGINALIA-created online storage is private by default
- public publishing is a separate feature and separate consent boundary
- token/credential data is not portable project data
- provider token must not reach renderer state, logs, URLs, project files, or diagnostics
- private Shelf evidence must not leak into public/project projections
- remote identity and visibility are verified before transport
- local writing works without authentication
- failed cloud operations leave local work usable

---

## 16. Implementation order when cloud work resumes

Recommended order:

1. re-read the Repository Core freeze and current main state
2. verify the current local baseline
3. use one main-process cloud coordinator for product cloud operations
4. preserve pending-ledger idempotency and fail-closed malformed state
5. complete the "オンラインに保存" product route
6. complete private provisioning / connection wiring
7. complete safe Sync product wiring
8. complete recovery deduplication
9. complete isolated fresh-copy Restore
10. add the dedicated History Viewer to the activity/primary-sidebar system
11. perform explicit live GitHub acceptance
12. only after the core online-storage experience is reliable, begin collaboration / Issue slices

Do not create a second cloud state machine merely because existing components are incomplete.

---

## 17. Acceptance criteria for the online-storage slice

A clean Windows user should be able to:

1. install and start MAGINALIA
2. complete or skip the Start Guide
3. optionally connect GitHub from the Start Guide without manually handling a token
4. create/use a Project, Workdesk, or Private Shelf locally
5. keep working if GitHub was skipped or unavailable
6. press "オンラインに保存"
7. have MAGINALIA create or resolve private GitHub storage without repository/branch setup
8. reopen the app without losing the connection metadata
9. save locally independently of the network
10. explicitly save/synchronize online without destructive conflict handling
11. view local History from the dedicated left-side History Viewer
12. open History / recovery / remote work as safe fresh copies when required
13. open the same MAGINALIA work from another machine without learning clone/fetch/pull

The slice is not accepted merely because provider mocks pass. A separately authorized live GitHub acceptance run is required.

---

## 18. Future acceptance direction

Later collaboration work should prove that a user can:

- share or open another person's Project through MAGINALIA
- receive an automatically created working branch without learning branch management
- create an Issue from relevant context
- review project Issues in the left-side Issue Viewer
- move between Issue discussion and the referenced working context
- preserve the owner's baseline and avoid destructive merge behavior

These are future product requirements, not authorization to implement them inside the current cloud-hardening slice.

---

## 19. Explicit non-goals for the current handoff

This handoff does not authorize:

- public repository creation
- automatic publication
- force push
- automatic merge into active work
- destructive reset
- real-time co-authoring backend
- CRDT/OT editing
- automatic PR workflow
- arbitrary Git hosting provider implementation
- exposing repository/branch/token fields in Normal UI
- reintroducing legacy Capture GitHub panels
- replacing ordinary files / Git History with a proprietary cloud database

---

## 20. One-line product rule

> **MAGINALIA presents online storage, History, sharing, and discussion as properties of the user's intellectual work; GitHub and Git remain replaceable infrastructure behind that experience.**
