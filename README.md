# MDW: mise dev workflows

MDWは、miseのファイルタスクを公開入口にして、組み合わせ可能なPythonワークフロー関数を実行する基盤のPoCです。既存のAWF（Agentic Workflow）による並列コードレビューを、最初の再利用対象として移行しています。Python 3.14の標準ライブラリを使います。

`.mise/tasks/awf/`フォルダーを別のプロジェクトの`.mise/tasks/`にコピーし、必要な`AWF_`環境変数を設定して利用できます。コピー先ではPython 3.14、Git、利用するCLIを実行できるようにし、macOSとLinuxではタスクファイルに実行権限を付けてください。生成される`.reviews/`はGitの管理対象から除外してください。

## 事前準備

- mise、Git、利用するCodex CLIまたはClaude Code CLIをインストールし、各CLIでログインしてください。
- `mise install`でPython 3.14を用意してください。初回はmiseによるプロジェクト設定の信頼確認が表示される場合があります。
- レビュー対象の変更をコミットしてください。既定では`main`と`HEAD`の共通祖先から`HEAD`までのコミット済みの変更を対象とし、未コミットの変更を含めないよう各CLIへ依頼します。
- AIのサービスへ差分が送信されるため、送信してよい内容かを確認してください。

## 実行

```text
mise tasks ls --json
mise run mdw:review --help
mise run mdw:review
```

`mdw:review`は、既存AWFのレビュー部品を組み合わせるMDWの入口です。`mise run awf:review`も同じPython関数を呼び出す互換入口として残しています。どちらも対象コミットの固定、設定と認証の確認、セキュリティと品質の並列レビュー、結果の集約を行い、`.reviews/merged.json`を作成します。`awf:review:prepare`、`awf:review:security`、`awf:review:quality`は、個別のmiseタスクとしても実行できます。Pythonは差分の本文を読み込まず、各CLIには同じコミットIDとファイル一覧を渡し、差分と周辺コードの確認を依頼します。同じ作業ディレクトリーで複数のレビューを同時に実行しないでください。

`.mise/tasks/`をPythonの検索パスに追加すると、別のワークフローから`from mdw._lib.workflows.review import run`で呼び出せます。`run()`は集約結果を辞書として返し、ファイルへの保存も行います。対象の固定だけが必要な場合は、同じモジュールの`prepare()`を呼び出せます。

`mise run awf:check`では、レビューで利用するCLIの設定と認証だけを確認できます。モデルを実際に利用できるかどうかは、レビュー実行時に各CLIが判断します。

出力先とレビュー対象は、`mise run mdw:review`または`mise run awf:review`を実行した場所のGit worktreeのルートです。worktreeのサブフォルダーから実行しても、そのworktree内の`.reviews/`に出力します。

`AWF_REVIEW_BASE`にはPRのベースとなるブランチまたはコミットを、`AWF_REVIEW_HEAD`にはレビュー対象のブランチまたはコミットを指定できます。既定値はそれぞれ`main`と`HEAD`です。ベースとヘッドの共通祖先からヘッドまでを比較するため、PRのベースブランチに合わせて`origin/main`などを指定してください。必要なコミット履歴がローカルにない場合は、あらかじめ取得してください。`AWF_REVIEW_TIMEOUT_SECONDS`で各CLIのタイムアウトを秒単位で変更できます。既定値は600秒です。実行前に以前の成果物を削除するため、レビューが失敗した場合、以前の`merged.json`は残りません。レビュー結果には機密情報が含まれる可能性があります。

## プロバイダーとモデルの設定

`mise.toml`は`.mdw/models.env`と任意の`.mdw/models.local.env`を読み込みます。共有してよい既定値は前者に置き、個人用の上書きはGit管理外の後者に置きます。`mise.local.toml`にも個人用の上書きを置けます。同じ環境変数については、miseがenvファイルを記述順に読み込み、後のファイルが前の値を上書きします。さらに、`mise.local.toml`は`mise.toml`より後に読み込まれるため、同じ変数の値が優先されます。dotenvの値は、miseを起動した環境に同じ変数がある場合も置き換えます。[envファイルの読み込み](https://mise.jdx.dev/environments/#env_._file)と[設定ファイルの優先順位](https://mise.jdx.dev/environments/#precedence)を参照してください。

レビュー設定は、役割ごとの`MDW_REVIEW_<ROLE>_*`、旧設定との互換用`AWF_REVIEW_<ROLE>_*`、レビュー共通の`MDW_REVIEW_*`、`MDW_DEFAULT_*`の順で解決します。どこにも値がない場合は、Python側の既定値を使います。既定では両方の観点にCodexを使います。モデルとエフォートの組み合わせの利用可否は契約やCLIの設定によって異なるため、必要に応じて変更してください。

`AWF_REVIEW_BASE`と`AWF_REVIEW_HEAD`はレビュー対象の範囲を指定するため、従来どおり`mise.toml`などで設定します。以前の`REVIEW_`で始まる設定は、`AWF_REVIEW_`で始まる名前に変更してください。Claude APIキーには`AWF_ANTHROPIC_API_KEY`を使用します。APIキーは`.mdw/models.env`やGit管理対象の設定ファイルには記載せず、環境変数または秘密情報管理ツールから渡してください。

共有の`.mdw/models.env`でレビュー全体の既定値を設定する例:

```dotenv
MDW_DEFAULT_PROVIDER=codex
MDW_DEFAULT_MODEL=gpt-6.1-sol
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

同じ設定は`mise.local.toml`の`[env]`にも記述できます。既存の`AWF_REVIEW_SECURITY_*`と`AWF_REVIEW_QUALITY_*`も引き続き読み込みます。

Claude APIを使う場合は`MDW_REVIEW_SECURITY_BILLING=api`を指定し、秘密情報管理ツールなどを使って実行環境に`AWF_ANTHROPIC_API_KEY`を渡してください。キーは設定ファイルへ記載しないでください。キーはClaudeの子プロセスに限って`ANTHROPIC_API_KEY`として渡します。CodexのAPI課金、Claudeのクラウドプロバイダーやゲートウェイには、このPoCは対応していません。

実行前にCLIの認証状態を確認し、指定された方式と一致しない場合は失敗します。CLIの認証状態や課金設定は変更されることがあるため、実際の利用明細と設定も確認してください。CLIのエラー出力は秘密情報の露出を避けるため表示しません。失敗時は各CLIの認証、モデル、設定を個別に確認してください。

エフォートはCodexでは`model_reasoning_effort`として、Claudeでは`--effort`として指定します。利用できる値はプロバイダーとモデルによって異なります。結果には指定したエフォートを記録します。

## 結果と検証範囲

`merged.json`には指定されたベースとヘッド、固定したコミットID、共通祖先、変更ファイル一覧、実行ID、全体の実行時間と、観点ごとのプロバイダー、モデル、エフォート、課金方式、実行時間、元の指摘を保持します。実行時間は、全体では準備タスクの開始から集約結果の保存直前まで、各観点ではレビュータスクの開始から結果の検証完了までの秒数です。重複の除去や指摘の採否は行いません。`findings: []`は指摘なしを表します。各ファイルの確認状況を`file_coverage`に、読み取れないファイルやツールの制限などを`limitations`に記録するよう依頼します。ファイルの確認状況が報告されなかった場合、Pythonが`limitations`に追記します。Gitがバイナリーと判定したファイルは、確認状況がモデルの申告である旨を追記します。

```json
{
  "target": {"run_id": "...", "base_ref": "main", "head_ref": "HEAD", "base_commit": "...", "merge_base_commit": "...", "head_commit": "...", "changed_files": [{"path": "app.py", "binary": false, "path_encoding_error": false}]},
  "duration_seconds": 32.1,
  "reviews": [
    {"reviewer_id": "security", "provider": "codex", "model": "gpt-6.1-sol", "effort": "medium", "billing": "subscription", "duration_seconds": 30.0, "target": {}, "review": {"findings": [], "limitations": [], "file_coverage": [{"file": "app.py", "status": "reviewed", "detail": "コミット間の差分を確認"}]}},
    {"reviewer_id": "quality", "provider": "codex", "model": "gpt-6.1-sol", "effort": "medium", "billing": "subscription", "duration_seconds": 32.0, "target": {}, "review": {"findings": [], "limitations": [], "file_coverage": [{"file": "app.py", "status": "reviewed", "detail": "コミット間の差分を確認"}]}}
  ]
}
```

各`target`には、実際には上位の`target`と同じ値が入ります。共通スキーマは`awf/_common.py`に含まれます。Python側では、このスキーマで使用する必須フィールド、型、列挙値、最小値と余分なフィールドを個別に検証します。汎用のJSON Schema検証器ではないため、スキーマを変更するときはPython側の検証も更新してください。

Codexには読み取り専用のサンドボックスを指定し、Claudeにはファイル検索・読み取りとBashのツールを許可して、planモードで起動します。コミットIDを使って差分とファイルを調べるよう依頼しますが、作業ツリーのファイルを読めないように隔離するものではありません。CLI自身の設定、フック、プラグイン、管理者設定なども完全には隔離しません。CLIのツールが読めない文字コードや、Gitがバイナリーと扱うファイルがある場合、モデルによって確認の可否が異なります。`limitations`はモデルの申告であり、すべての確認漏れを自動検知するものではありません。Judgeによる重複・矛盾の判断と、その効果の比較は今後の検証です。

macOSでは、CodexのChatGPT認証を用いた2並列の実行と集約、個人設定の上書きを確認しました。混在する文字コードの自作ファイルをコミットして実行し、ファイルごとの確認状況と結果を確認しています。WindowsとLinux、コミットID方式でのClaudeの実接続とAPIの課金先は未検証です。

## Docs: ADRの作成と検索

Docsは、ADRの作成、検索、規約の検証を行うPoCです。miseとPython 3.14を用意して、次のように実行します。

```text
mise tasks ls --json
mise run docs:new --help
mise run docs:new adr "採用するデータベース"
mise run docs:search "データベース"
mise run docs:validate
```

作成と検索は、ID、タイトル、種別、プロジェクトルートからの相対パスをJSONで返します。検索は大文字と小文字を区別せず、メタデータと本文から文字列を探します。該当しない場合は空の配列を返します。検索結果の`path`から通常のファイル読み取りで本文を参照できます。コマンドの結果は標準出力へ、miseの実行状況は標準エラー出力へ出ます。引数が不足している場合などは、miseがエラーを表示します。

文書は`docs/decisions/`に保存されます。先頭の`---`の間に、`id`、`title`、`type`を含む**一行のJSON**を記載します。一般的なYAMLのFrontmatterには対応していません。IDは`ADR-0001`の形式で、ファイル名は`0001.md`または`0001-説明.md`の形式です。ファイル名とIDの番号は一致させます。本文中の`[[ADR-0001]]`はADRのIDへの参照として扱います。

`docs:validate`は、メタデータ、ファイル名、重複IDと`[[ADR-...]]`形式の参照先を検証します。結果をJSONで返し、違反があれば終了コードを1にします。Markdownの通常のリンク、内容の正しさ、AIが文書を実際に読んだかどうかは検証しません。現時点ではCIへの組み込みは行っていません。

別のプロジェクトでは`.mise/tasks/docs/`をコピーし、miseとPythonを利用できるようにしてください。macOS / Linuxでは、公開するタスクの実行権限を保持してください。コピー先の`docs/decisions/`も上記の形式に従う必要があります。Windowsでの動作は未検証です。

Pythonの共通処理を`_lib/`に置く理由と制約は[ADR 0001](docs/decisions/0001-mise-task-python-library.md)に記録しています。macOSまたはLinuxで、コピー後のDocsタスク、miseによるタスクの検出とPythonのimportを次のコマンドで検証できます。

```text
mise exec -- python -m unittest discover -s tests -v
```
