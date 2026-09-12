# MAGINALIA Project Plan

Status: living plan  
Owner: beyond the Word / MAGINALIA project  
Last major reset: 2026-08-16

この `plan/` は、MAGINALIA 系プロダクトを「雰囲気で増えた実装」から、説明可能・交換可能・段階的に保守できる OSS へ移すための計画上の正本です。

## まず守ること

1. **Start simply.** 最小の vertical slice を先に通す。
2. **Divide and conquer.** UI・domain・保存・外部サービス接続を分離する。
3. **餅は餅屋。** Git は Git、GitHub は GitHub、OCR は OCR engine、Code-OSS は Code-OSS に任せる。MAGINALIA はそれらを人文学の作業として接続する。
4. **Tools are replaceable; research data is permanent.** 独自アプリが消えても Markdown / YAML / JSON / images / Git history が残る。
5. **Backend-minimal.** 端末、ordinary files、GitHub、static hosting、外部 Provider で済むものはそこで済ませる。小さな backend は必要性が明確なときだけ使い、研究データの正本にはしない。
6. **単体で役に立ち、組み合わせると強くなる。** IDE / Quote Capture / Input は単独利用可能で、Workspace はそれらを接続する。
7. **Simple outside, complex inside.** 第一利用者はPCに詳しくない文系学生・研究者・書き手。技術の複雑さを通常UIへ漏らさない。
8. **非プログラマの代表者が説明できる構造にする。** 新しい重要概念は、コードだけでなく Markdown と Mermaid 図で説明できなければ完成とみなさない。

## Current products

- MAGINALIA IDE
- MAGINALIA Quote Capture
- MAGINALIA Input
- MAGINALIA Workspace

Product naming rules: [`16_PRODUCT_NAMING.md`](16_PRODUCT_NAMING.md)

## Active cycle

- 4-week baseline: [`06_INITIAL_4W_PLAN.md`](06_INITIAL_4W_PLAN.md)
- Current sprint: [`sprints/2026-W34.md`](sprints/2026-W34.md) — 2026-08-17 → 2026-08-23

## このフォルダの文書

- [`00_MANIFESTO.md`](00_MANIFESTO.md): 開発・OSS・プロダクト境界のマニフェスト
- [`01_REPOSITORY_AUDIT.md`](01_REPOSITORY_AUDIT.md): 既存4 repo の再利用・凍結・廃棄候補
- [`02_ARCHITECTURE.md`](02_ARCHITECTURE.md): 全体アーキテクチャ、unit 境界、相互作用、状態遷移
- [`03_TECH_STACK.md`](03_TECH_STACK.md): 技術スタックと採用理由
- [`04_PRODUCT_GOALS.md`](04_PRODUCT_GOALS.md): 各プロダクト α1 / β1 / Workspace β1 の Do / Do not
- [`05_DEVELOPMENT_CADENCE.md`](05_DEVELOPMENT_CADENCE.md): 週次 sprint、Codex token 単位、一ヶ月レビューと再調整
- [`06_INITIAL_4W_PLAN.md`](06_INITIAL_4W_PLAN.md): 2026-08-17 からの初回4週間計画
- [`07_FLOWS.md`](07_FLOWS.md): オブジェクト別 flowchart、統合 flow、state diagram
- [`08_QUALITY_AND_TESTING.md`](08_QUALITY_AND_TESTING.md): unit test、contract test、integration test、acceptance criteria
- [`09_DECISION_LOG.md`](09_DECISION_LOG.md): 決定事項の短い台帳。重大判断は `docs/decisions/` に ADR を追加
- [`10_MAINTENANCE_AND_EXTENSION.md`](10_MAINTENANCE_AND_EXTENSION.md): OSS 拡張点、互換性、保守・説明責任
- [`11_UX_PRINCIPLES.md`](11_UX_PRINCIPLES.md): 文系・非技術ユーザーを第一にしたUI/用語/エラー設計
- [`12_DISTRIBUTION_AND_ONBOARDING.md`](12_DISTRIBUTION_AND_ONBOARDING.md): インストーラー、初期設定、GitHub接続、配布
- [`13_MILESTONE_SEQUENCE.md`](13_MILESTONE_SEQUENCE.md): α1 → β1 → Workspace β1 の月次ゲート順序
- [`14_RISK_REGISTER.md`](14_RISK_REGISTER.md): architecture / UX / privacy / development risk
- [`15_OSS_GOVERNANCE.md`](15_OSS_GOVERNANCE.md): OSSライセンス、ブランド、Format、contribution境界
- [`16_PRODUCT_NAMING.md`](16_PRODUCT_NAMING.md): 現行プロダクト名と互換上の命名ルール
- [`17_CAPTURE_REVIEW_UX_SPEC.md`](17_CAPTURE_REVIEW_UX_SPEC.md): Android引用採集とPC確認・検索の実装済みP0 UX仕様
- [`templates/SPRINT_TEMPLATE.md`](templates/SPRINT_TEMPLATE.md): 週次 sprint テンプレート
- [`templates/MONTHLY_REVIEW_TEMPLATE.md`](templates/MONTHLY_REVIEW_TEMPLATE.md): 月次 review / 再計画テンプレート
- [`templates/FEATURE_SPEC_TEMPLATE.md`](templates/FEATURE_SPEC_TEMPLATE.md): 新機能の unit / flow / state / test 仕様テンプレート

## Benchmarks / execution prompts

- [`benchmarks/2026-09-05_GPT6_ASTRA_MAGINALIA_IDE_BENCHMARK_PROMPT.md`](benchmarks/2026-09-05_GPT6_ASTRA_MAGINALIA_IDE_BENCHMARK_PROMPT.md): 旧 peak-capability benchmark prompt。長大な自己完結Prompt方式の比較対象として保持
- [`benchmarks/2026-09-11_REPOSITORY_CORE_LEAN_BENCH_PIVOT.md`](benchmarks/2026-09-11_REPOSITORY_CORE_LEAN_BENCH_PIVOT.md): Repository Core / GitHub連携benchを repository-native instructions + 分離run へ転換した進捗・方針記録
- [`benchmarks/2026-09-11_GPT6_ASTRA_REPOSITORY_CORE_LEAN_PROMPT.md`](benchmarks/2026-09-11_GPT6_ASTRA_REPOSITORY_CORE_LEAN_PROMPT.md): Astra用の短い実装専用Prompt。独立検証前で停止する
- [`benchmarks/2026-09-11_GPT6_ASTRA_REPOSITORY_CORE_VERIFICATION_PROMPT.md`](benchmarks/2026-09-11_GPT6_ASTRA_REPOSITORY_CORE_VERIFICATION_PROMPT.md): 別runでテスト・security review・live evidenceを判定する独立検証Prompt

このフォルダは canonical specification そのものではなく、現行の plan / ADR / repository を特定のモデルや開発環境へ渡すための実行用文書を置く。benchmark prompt が Accepted ADR や Decision Log より優先されるのは、その benchmark run の agent behavior と作業手順に限る。プロダクト仕様の正本順位は下記を維持する。

## 文書の優先順位

矛盾時は次の順で優先します。

1. accepted ADR (`docs/decisions/`)
2. `plan/09_DECISION_LOG.md` の Accepted decision
3. `plan/00_MANIFESTO.md`、`plan/11_UX_PRINCIPLES.md`、`plan/16_PRODUCT_NAMING.md`
4. `plan/02_ARCHITECTURE.md` と `plan/04_PRODUCT_GOALS.md`
5. 週次・月次計画
6. 過去の discussion / bootstrap 文書

過去文書は捨てず、歴史資料として扱います。ただし古い計画を現在の実装指示として自動採用しません。

## 計画変更のルール

- 可逆・低リスクな判断は sprint 内で行い、Decision Log に1行残す。
- data format、public/private boundary、license、repo topology、backend role、Code-OSS core patch、cross-product contract ownership を変える場合は ADR が必要。
- scope を増やすときは必ず「同じ milestone から何を外すか」を併記する。
- 月次 review では、完成率より **end-to-end flow が何本通ったか** を優先して評価する。
- 通常UIへ新しい専門知識を要求する変更は、UX debt として明示する。

## Done の共通定義

機能は次を全部満たして初めて Done とします。

- 責務が一文で説明できる
- public interface / data contract が明文化されている
- unit test がある
- 外部依存は adapter 境界の外側にある
- failure path が定義されている
- Mermaid で入力→状態→出力を追える
- 他プロダクトがなくても単独で壊れない
- 研究データを独自 binary format に閉じ込めない
- 通常ユーザーに不必要な Git / terminal / API 等の知識を要求しない
