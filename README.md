# MDW: mise dev workflows

MDWは、miseのファイルタスクを公開入口にして、組み合わせ可能なワークフローの部品を実行する基盤のPoCです。セキュリティと品質の観点から並列にコードレビューする機能を備えています。Node.js 24の標準機能を使います。

`.mise/tasks/mdw/`フォルダーを別のプロジェクトの`.mise/tasks/`にコピーし、必要に応じて`MDW_`環境変数を設定して利用できます。コピー先ではNode.js 24、Git、利用するCLIを実行できるようにし、macOSとLinuxではタスクファイルに実行権限を付けてください。共有のモデル設定を使う場合は`.mdw/models.env`と`mise.toml`のenvファイル設定もコピーしてください。生成される`.reviews/`はGitの管理対象から除外してください。

## AI に使い方を読ませる

AI 向けの入口は [MDWの使い方とワークフロー](.mise/tasks/mdw/README.md) です。「このガイドを読んでから作業して」と依頼すると、自然言語の指示から intent の記録、インタビュー、レビュー、worktree の作成などを選ぶための手順が分かります。ガイドは `.mise/tasks/mdw/` と一緒に別のプロジェクトへコピーできます。継続して使う場合は、対象プロジェクトの AI 向け指示にガイドへの参照を追加してください。生成される `AGENTS.md` では、その生成元に追加します。

## Intent: 現在の会話から方針を記録する

「今の共通化する方式、intent に入れておいて」のように AI へ依頼できます。ガイドを読んだ AI は、次のタスクから共通の更新手順を取得し、現在の会話を使って `docs/intent.md` を編集します。

```sh
mise run mdw:intent
```

このタスクは更新手順を出力します。別の AI を起動せず、ファイルの読み書きも行いません。出力を受け取った AI が既存の intent と会話を照合し、本人からの明確な記録依頼であれば再承認を求めずに更新します。意味が複数ある場合や、既存の方針との矛盾が解消されていない場合は、一問確認します。AI CLI のインストールと認証は不要です。端末で実行しただけでは保存されないため、出力を現在の会話を持つ AI に読ませてください。

更新ルールは [intent の共通更新手順](.mise/tasks/mdw/prompts/intent.md) にまとめています。`mdw:interview` も同じ手順をプロンプトに取り込みます。

## 事前準備

- mise、Git、利用する Codex CLI・Claude Code CLI・Antigravity CLI（`agy` v1.1.27 以上）のいずれかをインストールし、各 CLI でログインしてください。`agy` で `--output-format json`、`--json-schema`、`--disable-slash-commands`、`denied_actions` が使えない場合は `agy update` で更新してください。
- `mise install`でNode.js 24とBiomeの最新版を用意してください。初回はmiseによるプロジェクト設定の信頼確認が表示される場合があります。
- レビュー対象の変更をコミットしてください。既定では`main`と`HEAD`の共通祖先から`HEAD`までのコミット済みの変更を対象とし、未コミットの変更を含めないよう各CLIへ依頼します。
- AIのサービスへ差分が送信されるため、送信してよい内容かを確認してください。

## 実行

```text
mise tasks ls --json
mise run mdw:review --help
mise run mdw:review
mise run mdw:review --base origin/main --head HEAD
```

`mdw:review`は、対象コミットの固定、設定と認証の確認、セキュリティと品質の並列レビュー、結果の集約を行い、`.reviews/merged.json`を作成します。`mdw:review:prepare`、`mdw:review:security`、`mdw:review:quality`も同じ`--base`と`--head`を受け付けます。個別のレビューでは対象の準備と認証の確認を行ってから、その観点だけを実行します。Node.jsは差分の本文を読み込まず、各CLIには同じコミットIDとファイル一覧を渡し、差分と周辺コードの確認を依頼します。同じ作業ディレクトリーで複数のレビューを同時に実行しないでください。

旧`awf:*`タスクは`mdw:*`へ統合しました。たとえば、`awf:review`は`mdw:review`に、`awf:check`は`mdw:check`に変更してください。

レビューの流れは `.mise/tasks/mdw/review.mts` の `run()` に記述しています。別のワークフローからは、`.mise/tasks/mdw/_lib/review.mts`の`run()`を相対パスでimportして呼び出せます。`run()`は集約結果をオブジェクトとして返し、ファイルへの保存も行います。`run({ baseRef, headRef })`でレビュー対象を指定でき、対象の固定だけが必要な場合は`prepare()`を呼び出せます。

`mise run mdw:check`では、レビューで利用するCLIの設定と認証だけを確認できます。モデルを実際に利用できるかどうかは、レビュー実行時に各CLIが判断します。

出力先とレビュー対象は、`mise run mdw:review`を実行した場所のGit worktreeのルートです。worktreeのサブフォルダーから実行しても、そのworktree内の`.reviews/`に出力します。

`--base`にはPRのベースとなるブランチまたはコミットを、`--head`にはレビュー対象のブランチまたはコミットを指定できます。既定値はそれぞれ`main`と`HEAD`です。ベースとヘッドの共通祖先からヘッドまでを比較するため、PRのベースブランチに合わせて`origin/main`などを指定してください。必要なコミット履歴がローカルにない場合は、あらかじめ取得してください。`MDW_REVIEW_TIMEOUT_SECONDS`で各CLIのタイムアウトを秒単位で変更できます。既定値は600秒です。実行前に以前の成果物を削除するため、レビューが失敗した場合、以前の`merged.json`は残りません。レビュー結果には機密情報が含まれる可能性があります。

## Interview: 対話から intent を作る

`mdw:interview` は、壁打ちや雑談を通じてプロジェクトの思想や目指す姿を言葉にする、対話型のワークフローです。Codex CLI、Claude Code CLI、または Antigravity CLI（`agy`）にプロンプトを渡し、会話から見えてきた判断基準を `docs/intent.md` にまとめるよう依頼します。端末で実行してください。

```sh
mise run mdw:interview
```

AI は既存の `docs/intent.md`、`README.md`、リポジトリの構成などを軽く見たうえで、丸投げの質問を避けて具体的な切り口から会話を始めます。会話中は仮説や対比、たとえ話をフックにしながら壁打ちを広げ、話題が一区切りついたときや終了時に要点を整理し、本人の合意を得て `docs/intent.md` へ反映します。途中で明示的に記録を依頼された場合はその場で反映します。会話ログやセッションの要約はプロジェクトに作成しません。AI CLI 自身の会話履歴は、その CLI の設定に従います。

intent には、目指すこと、大切にすることとその理由、状況に応じた判断基準、まだ決まっていないことを記載します。未確認の解釈を方針として保存したり、希望を禁止事項へ強めたりしないように指示しています。会話の進め方は [インタビュープロンプト](.mise/tasks/mdw/prompts/interview.md)、記録のルールは [intent の共通更新手順](.mise/tasks/mdw/prompts/intent.md) で調整できます。記録の正しさや保存は AI が実行するため、実際の差分も確認してください。

既存の AI チャットで使う場合は、プロンプトだけを取得して渡せます。プロンプトの出力では AI CLI のインストールや認証は不要で、intent も作成・変更しません。対象の worktree で会話を進めるようにしてください。

```sh
mise run mdw:interview --prompt
```

実行場所が属する worktree のルートで AI CLI を起動するため、サブフォルダーから実行しても intent の相対パスは変わりません。ファイルを変更する場合は、対象プロジェクトの作業用 worktree の規約に従います。このプロジェクトでは作業用 worktree で実行してください。

AI の設定は `MDW_INTERVIEW_PROVIDER`、`MDW_INTERVIEW_MODEL`、`MDW_INTERVIEW_EFFORT`、`MDW_INTERVIEW_BILLING` を使い、未指定の項目には対応する `MDW_DEFAULT_*` を使います。モデルを未指定にすると `--model` を渡さず各 AI CLI の既定モデルを使います。`MDW_DEFAULT_MODEL` を指定している状態で別のプロバイダーへ切り替える場合は、対応するモデルも併せて指定してください。起動前に共通の `AgentClient` で設定と CLI の場所を検証し、指定された課金方式と認証状態が一致することを確認します。権限の確認には、対話型 CLI の通常の仕組みを使います。Codex は `workspace-write` と `on-request` で起動し、Claude と `agy` の権限設定は各 CLI に従います。`agy` の対話起動には `--prompt-interactive` を使います。

intent は、後の AI が設計・実装・提案に迷ったときの判断材料です。対象プロジェクトの AI 向け指示には「`docs/intent.md` が存在する場合は、判断の前に読み、明示された要件や上位の指示を優先する。適用する条件が不明な場合は本人に確認する」と記載してください。生成される `AGENTS.md` を使う場合は、その生成元へ追記してください。このタスクは `AGENTS.md` を変更しません。

代替 CLI を使ってプロンプトの受け渡しと起動を検証しています。実際の AI との対話、質問の深さ、intent の更新品質は試用時の確認項目です。

## Issue: 壁打ちから GitHub Issue を作る

`mdw:issue:new` は、壁打ちを通じて要件・設計方針・テスト観点（testent：正常系・異常系・権限・境界値・障害）を詰め、本人の合意を得てから GitHub Issue を作成する対話型のワークフローです。テーマを引数で渡して始めることもできます。

```sh
mise run mdw:issue:new
mise run mdw:issue:new "agy プロバイダーを追加したい"
```

既存の AI チャットでそのまま壁打ちする場合は、`--prompt` でプロンプトだけを取得できます。プロンプトの出力では AI CLI のインストールや認証は不要で、ファイルや GitHub への書き込みも行いません。

```sh
mise run mdw:issue:new --prompt
mise run mdw:issue:new --prompt "agy プロバイダーを追加したい"
```

AI の設定は `MDW_ISSUE_PROVIDER`、`MDW_ISSUE_MODEL`、`MDW_ISSUE_EFFORT`、`MDW_ISSUE_BILLING` を使い、未指定の項目には対応する `MDW_DEFAULT_*` を使います。会話の進め方は [Issue 作成プロンプト](.mise/tasks/mdw/prompts/issue.md) で調整できます。合意前に外部へ起票しないよう指示しており、実際の起票には認証済みの `gh` CLI が必要です。代替 CLI を使ってプロンプトの受け渡しと起動を検証しています。実際の AI との対話品質や Issue 起票動作は試用時の確認項目です。

## 指摘の評価と PR への投稿

レビューを実行した worktree で、集約済みの指摘を Judge に渡します。Judge は対象の差分と照らし合わせて各指摘を採用、棄却、根拠不足、重複のいずれかに分類し、判定の根拠を `.reviews/judged.json` に保存します。モデル設定は `MDW_REVIEW_JUDGE_PROVIDER`、`MDW_REVIEW_JUDGE_MODEL`、`MDW_REVIEW_JUDGE_EFFORT`、`MDW_REVIEW_JUDGE_BILLING` で上書きできます。指摘がなければ AI CLI は起動しません。

```sh
mise run mdw:review:judge
mise run mdw:review:post --dry-run
mise run mdw:review:post --pr https://github.com/OWNER/REPO/pull/123
```

投稿タスクには、対象リポジトリでレビューを投稿できる認証済みの `gh` が必要です。PR のベースとヘッドが評価時のコミットに一致することを確認し、採用した指摘だけを対象コミットに紐づくレビューコメントとして投稿します。同じ本文を同じコミットに投稿済みの場合は、そのレビューの URL を返します。ベースかヘッドが変わった場合は、PR の現在のコミットを指定してレビューと評価をやり直してください。

## プロバイダーとモデルの設定

`mise.toml`は`.mdw/models.env`と任意の`.mdw/models.local.env`を読み込みます。共有してよい既定値は前者に置き、個人用の上書きはGit管理外の後者に置きます。`mise.local.toml`にも個人用の上書きを置けます。同じ環境変数については、miseがenvファイルを記述順に読み込み、後のファイルが前の値を上書きします。さらに、`mise.local.toml`は`mise.toml`より後に読み込まれるため、同じ変数の値が優先されます。dotenvの値は、miseを起動した環境に同じ変数がある場合も置き換えます。[envファイルの読み込み](https://mise.jdx.dev/environments/#env_._file)と[設定ファイルの優先順位](https://mise.jdx.dev/environments/#precedence)を参照してください。

レビュー設定は、役割ごとの`MDW_REVIEW_<ROLE>_*`、旧設定との互換用`AWF_REVIEW_<ROLE>_*`、レビュー共通の`MDW_REVIEW_*`、`MDW_DEFAULT_*`の順で解決します。どこにも値がない場合、プロバイダーは`codex`、エフォートは`medium`、課金方式は`subscription`を使い、モデルについては`--model`を渡さず各AI CLI側の既定モデルに委ねます。モデルとエフォートの組み合わせの利用可否は契約やCLIの設定によって異なるため、必要に応じて変更してください。

レビュー範囲の`MDW_REVIEW_BASE`、`MDW_REVIEW_HEAD`と旧`AWF_REVIEW_BASE`、`AWF_REVIEW_HEAD`は読み込みません。代わりに`--base`、`--head`または部品の引数を使ってください。タイムアウトの旧`AWF_REVIEW_TIMEOUT_SECONDS`は引き続き読み込み、`MDW_REVIEW_TIMEOUT_SECONDS`を優先します。Claude APIキーには`MDW_ANTHROPIC_API_KEY`を使用し、旧`AWF_ANTHROPIC_API_KEY`も受け付けます。APIキーは`.mdw/models.env`やGit管理対象の設定ファイルには記載せず、環境変数または秘密情報管理ツールから渡してください。

共有の`.mdw/models.env`で全体の既定値を設定する例（`MDW_DEFAULT_MODEL`は任意で、未指定なら各CLIの既定モデルを使います）:

```dotenv
MDW_DEFAULT_PROVIDER=codex
# MDW_DEFAULT_MODEL=gpt-6.1-sol
MDW_DEFAULT_EFFORT=medium
MDW_DEFAULT_BILLING=subscription
```

個人の`.mdw/models.local.env`でセキュリティレビューだけをClaudeに切り替える例:

```dotenv
MDW_REVIEW_SECURITY_PROVIDER=claude
MDW_REVIEW_SECURITY_MODEL=sonnet
MDW_REVIEW_SECURITY_EFFORT=medium
MDW_REVIEW_SECURITY_BILLING=subscription
```

Antigravity CLI（`agy`）を使う例（`MDW_DEFAULT_MODEL` を未指定にすれば `agy` 側の既定モデルを使います）:

```dotenv
MDW_DEFAULT_PROVIDER=agy
MDW_DEFAULT_EFFORT=medium
```

同じ設定は`mise.local.toml`の`[env]`にも記述できます。既存の`AWF_REVIEW_SECURITY_*`と`AWF_REVIEW_QUALITY_*`も引き続き読み込みます。

Claude APIを使う場合は`MDW_REVIEW_SECURITY_BILLING=api`を指定し、秘密情報管理ツールなどを使って実行環境に`MDW_ANTHROPIC_API_KEY`を渡してください。キーは設定ファイルへ記載しないでください。キーはClaudeの子プロセスに限って`ANTHROPIC_API_KEY`として渡します。CodexのAPI課金、Claudeのクラウドプロバイダーやゲートウェイには、このPoCは対応していません。`agy` には独立した認証状態確認サブコマンドがないため、起動前に `agy models` で利用可能なモデルを取得できることを確認し、課金先・アカウントは `agy` CLI 側のログイン設定に委ねます。確認していない課金方式を誤記しないよう、`agy` の実行結果では `billing` に `"cli"` を記録します。子プロセスからは `GEMINI_API_KEY`・`GOOGLE_API_KEY`・`GOOGLE_GENAI_USE_VERTEXAI`・`AGY_ADC_AUTH` など他経路の環境変数を除外します。

実行前にCLIの認証状態（`agy` はモデル取得の疎通）を確認し、指定された方式と一致しない場合や未認証の場合は失敗します。CLIの認証状態や課金設定は変更されることがあるため、実際の利用明細と設定も確認してください。CLIのエラー出力は秘密情報の露出を避けるため表示しません。失敗時は各CLIの認証、モデル、設定を個別に確認してください。

エフォートはCodexでは`model_reasoning_effort`として、Claudeと`agy`では`--effort`として指定します。`agy` で `gemini-3.8-flash-low` のように末尾にエフォートを含むモデルを指定した場合は、CLI 側の競合を避けるため `--effort` を省略し、結果にはモデル名に含まれるエフォートを記録します。また、`gemini-pro-orchestrator-*` のように推論予算が固定された Orchestrator モデルを指定した場合も `--effort` を省略し、結果の `effort` には `null` を記録します。利用できる値はプロバイダーとモデルによって異なります。結果には適用したエフォートを記録します。

## 結果と検証範囲

`merged.json`には指定されたベースとヘッド、固定したコミットID、共通祖先、変更ファイル一覧、実行ID、全体の実行時間と、観点ごとのプロバイダー、モデル（未指定で各CLIの既定モデルを使った場合は`null`）、エフォート、課金方式、実行時間、元の指摘を保持します。`judged.json`の`judge.model`も同様に、未指定の場合は`null`を記録します。実行時間は、全体では準備タスクの開始から集約結果の保存直前まで、各観点ではレビュータスクの開始から結果の検証完了までの秒数です。重複の除去や指摘の採否は行いません。`findings: []`は指摘なしを表します。各ファイルの確認状況を`file_coverage`に、読み取れないファイルやツールの制限などを`limitations`に記録するよう依頼します。ファイルの確認状況が報告されなかった場合、プログラムが`limitations`に追記します。Gitがバイナリーと判定したファイルは、確認状況がモデルの申告である旨を追記します。

```json
{
  "target": {"run_id": "...", "base_ref": "main", "head_ref": "HEAD", "base_commit": "...", "merge_base_commit": "...", "head_commit": "...", "changed_files": [{"path": "app.py", "binary": false, "path_encoding_error": false}]},
  "duration_seconds": 32.1,
  "reviews": [
    {"reviewer_id": "security", "provider": "codex", "model": null, "effort": "medium", "billing": "subscription", "duration_seconds": 30.0, "target": {}, "review": {"findings": [], "limitations": [], "file_coverage": [{"file": "app.py", "status": "reviewed", "detail": "コミット間の差分を確認"}]}},
    {"reviewer_id": "quality", "provider": "codex", "model": null, "effort": "medium", "billing": "subscription", "duration_seconds": 32.0, "target": {}, "review": {"findings": [], "limitations": [], "file_coverage": [{"file": "app.py", "status": "reviewed", "detail": "コミット間の差分を確認"}]}}
  ]
}
```

各`target`には、実際には上位の`target`と同じ値が入ります。共通スキーマは`mdw/_lib/review-data.mts`に含まれます。プログラム側では、このスキーマで使用する必須フィールド、型、列挙値、最小値と余分なフィールドを個別に検証します。汎用のJSON Schema検証器ではないため、スキーマを変更するときは検証も更新してください。

ライブラリでは、`ReviewWorkspace`（`review-workspace.mts`）が worktree のルートと出力ファイルを扱い、`AgentClient`（`agent-client.mts`）が環境変数のスナップショット、ワークフローごとの設定の解決と検証、認証確認、AI CLI の構造化出力と対話の呼び出しを扱います。レビュー、Judge、interview、issue、worktree のブランチ名生成は同じクラスを使います。`workflow` には既定の `review`、`interview`、`issue`、`worktree` を指定でき、設定は各ワークフローの `MDW_*` から `MDW_DEFAULT_*` の順に解決します。レビューの役割ごとの設定と旧 `AWF_REVIEW_*` の互換性も保持します。各処理は実行ごとのインスタンスを使い、変更可能な共有のルートや出力先を持ちません。コマンド実行、JSON の読み書き、レビュー結果の検証は、それぞれのモジュールの関数として利用します。工程の順序と並列実行は、mise が実行するタスクファイルに記述します。

Codexには読み取り専用のサンドボックスを指定し、Claudeにはファイル検索・読み取りとBashのツールを許可してplanモードで起動します。`agy`には `--input-format text` で標準入力からプロンプトを渡し、`--sandbox`、`--disable-slash-commands`、およびセッション限定の `--settings`（`toolPermission: "request-review"`、`write_file(*)`・外部アクセス・MCP の拒否、`Bash` 許可時は読み取り系 `git` コマンドのみ `allow`）を指定したうえで、`--output-format json` と `--json-schema` で構造化出力を取得します（拒否されたツール呼び出し `denied_actions` は `limitations` に記録します。ただし `agy` のターミナルサンドボックス自体はワークスペース書き込みを OS レベルで完全隔離するものではありません）。コミットIDを使って差分とファイルを調べるよう依頼しますが、作業ツリーのファイルを読めないように隔離するものではありません。CLI自身の設定、フック、プラグイン、管理者設定なども完全には隔離しません。CLIのツールが読めない文字コードや、Gitがバイナリーと扱うファイルがある場合、モデルによって確認の可否が異なります。`limitations`はモデルの申告であり、すべての確認漏れを自動検知するものではありません。Judgeによる判定の精度と効果は今後の検証項目です。

macOS 上で Codex の ChatGPT 認証によるレビュー実接続、および `agy` の `models` 取得と `--input-format text --sandbox --disable-slash-commands --settings ... --output-format json --json-schema` による並列レビュー実接続を確認しました。Node.js 版の自動テストでは代替 CLI を用いて Codex・Claude・`agy` の並列実行、設定検証、対話引数、集約を検証しています。`agy` を使った対話品質、Claude の実接続、Windows と Linux での動作、Claude API の課金先は未検証です。

## Docs: ADRの作成と検索

Docsは、ADRの作成、検索、規約の検証を行うPoCです。miseとNode.js 24を用意して、次のように実行します。

```text
mise tasks ls --json
mise run docs:new --help
mise run docs:new adr "採用するデータベース"
mise run docs:search "データベース"
mise run docs:validate
```

作成と検索は、ID、タイトル、種別、プロジェクトルートからの相対パスをJSONで返します。検索はUnicode 16.0のケースフォールディングを使い、大文字と小文字を区別せず、メタデータと本文から文字列を探します。該当しない場合は空の配列を返します。検索結果の`path`から通常のファイル読み取りで本文を参照できます。コマンドの結果は標準出力へ、miseの実行状況は標準エラー出力へ出ます。引数が不足している場合などは、miseがエラーを表示します。

文書は`docs/decisions/`に保存されます。先頭の`---`の間に、`id`、`title`、`type`を含む**一行のJSON**を記載します。一般的なYAMLのFrontmatterには対応していません。IDは`ADR-0001`の形式で、ファイル名は`0001.md`または`0001-説明.md`の形式です。ファイル名とIDの番号は一致させます。本文中の`[[ADR-0001]]`はADRのIDへの参照として扱います。

`docs:validate`は、メタデータ、ファイル名、重複IDと`[[ADR-...]]`形式の参照先を検証します。結果をJSONで返し、違反があれば終了コードを1にします。Markdownの通常のリンク、内容の正しさ、AIが文書を実際に読んだかどうかは検証しません。現時点ではCIへの組み込みは行っていません。

別のプロジェクトでは`.mise/tasks/docs/`をコピーし、miseとNode.js 24を利用できるようにしてください。macOS / Linuxでは、公開するタスクの実行権限を保持してください。コピー先の`docs/decisions/`も上記の形式に従う必要があります。Windowsでの動作は未検証です。

Node.jsへの移行と部品の配置については[ADR 0002](docs/decisions/0002-node-workflow-runtime.md)に記録しています。macOSまたはLinuxで、Biomeの既定設定による検証と、コピー後のタスク、miseによるタスクの検出およびレビューの集約を次のコマンドで確認できます。

```text
mise run check
mise exec -- node --test tests/*.test.mts
```

個別に検証または整形する場合は、次のタスクを使います。`format`は対象ファイルを書き換えます。

```sh
mise run lint
mise run format
```

## 作業用 worktree

リポジトリの変更は、作業ごとに `.worktree/` 内の worktree で進めます。作業中の AI はブランチ名を決め、次のタスクを呼び出します。

```sh
mise run mdw:worktree:new --branch feat/passkey-login
```

シェルから作業内容を渡すと、MDW が AI CLI を呼び出してブランチ名を決めます。

```sh
mise run mdw:worktree:new "パスキー認証を追加する"
```

ブランチ名は `feat`、`fix`、`refactor`、`docs`、`test`、`chore`、`perf`、`build`、`ci`、`revert` のいずれかと、英小文字・数字・ハイフンによる説明を組み合わせます。名前が重複した場合は末尾に番号を付けます。AI の設定には `MDW_DEFAULT_PROVIDER`、`MDW_DEFAULT_MODEL`、`MDW_DEFAULT_EFFORT`、`MDW_DEFAULT_BILLING` を使用します。`MDW_WORKTREE_PROVIDER` などの `MDW_WORKTREE_` 設定で上書きできます。ブランチ名を AI に生成させる場合は、共通の `AgentClient` で設定と認証状態を確認し、プロバイダーに対応しないエフォートなどの不正な設定は起動前に拒否します。

作成タスクは `main` の追跡先から取得し、fast-forward で更新できる場合は `main` を更新します。ローカルの未プッシュのコミットは保持し、履歴が分岐した場合や更新を妨げる変更がある場合は中断します。作成結果は `branch`、`path`、`base_commit` を含む JSON です。`path` は絶対パスです。

マージ後は、対象の worktree の外から次のタスクを実行します。

```sh
mise run mdw:worktree:cleanup /絶対パス/.worktree/feat-passkey-login
```

クリーンアップは未コミット、未追跡、Git が無視するファイルがないことを確認します。通常マージは Git の履歴で確認し、squash merge は `gh` CLI で取得したマージ済み PR と差分を照合します。差分が一致しない場合など、マージ済みと確認できないときは削除しません。タスクはコミット、プッシュ、PR の作成、マージを行いません。親シェルのカレントディレクトリは変更できないため、対象の外から実行してください。
