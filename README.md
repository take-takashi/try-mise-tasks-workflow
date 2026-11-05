# AWF: Agentic Workflow

AWFは、miseのファイルタスクでAIエージェントを使うワークフローのシリーズです。現在は、同じGitのコミットをセキュリティと品質の2つの観点で並列レビューし、結果をJSONに集約するPoCを用意しています。Python 3.14の標準ライブラリを使います。

`mise-tasks/awf/`フォルダーを別のプロジェクトの`mise-tasks/`にコピーし、必要な`AWF_`環境変数を設定して利用できます。コピー先ではPython 3.14、Git、利用するCLIを実行できるようにし、macOSとLinuxではタスクファイルに実行権限を付けてください。生成される`.reviews/`はGitの管理対象から除外してください。

## 事前準備

- mise、Git、利用するCodex CLIまたはClaude Code CLIをインストールし、各CLIでログインしてください。
- `mise install`でPython 3.14を用意してください。初回はmiseによるプロジェクト設定の信頼確認が表示される場合があります。
- レビュー対象の変更をコミットしてください。既定では`main`と`HEAD`の共通祖先から`HEAD`までのコミット済みの変更を対象とし、未コミットの変更を含めないよう各CLIへ依頼します。
- AIのサービスへ差分が送信されるため、送信してよい内容かを確認してください。

## 実行

```text
mise run awf:review
```

miseの依存関係により、`awf:review:prepare`が対象のコミットと変更ファイルを固定し、`awf:review:check`が設定と認証を確認した後、`awf:review:security`と`awf:review:quality`を並列に実行します。両方が成功した場合にだけ`awf:review`が`.reviews/merged.json`を作成します。並列にするには、miseのジョブ数を2以上に設定してください（例: `mise run -j 2 awf:review`）。Pythonは差分の本文を読み込まず、各CLIには同じコミットIDとファイル一覧を渡し、差分と周辺コードの確認を依頼します。同じ作業ディレクトリーで複数のワークフローを同時に実行しないでください。

`mise run awf:check`では、レビューで利用するCLIの設定と認証だけを確認できます。モデルを実際に利用できるかどうかは、レビュー実行時に各CLIが判断します。

出力先とレビュー対象は、`mise run awf:review`を実行した場所のGit worktreeのルートです。worktreeのサブフォルダーから実行しても、そのworktree内の`.reviews/`に出力します。

`AWF_REVIEW_BASE`にはPRのベースとなるブランチまたはコミットを、`AWF_REVIEW_HEAD`にはレビュー対象のブランチまたはコミットを指定できます。既定値はそれぞれ`main`と`HEAD`です。ベースとヘッドの共通祖先からヘッドまでを比較するため、PRのベースブランチに合わせて`origin/main`などを指定してください。必要なコミット履歴がローカルにない場合は、あらかじめ取得してください。`AWF_REVIEW_TIMEOUT_SECONDS`で各CLIのタイムアウトを秒単位で変更できます。既定値は600秒です。実行前に以前の成果物を削除するため、レビューが失敗した場合、以前の`merged.json`は残りません。レビュー結果には機密情報が含まれる可能性があります。

## プロバイダーとモデルの設定

既定では両方の観点にCodexを使います。`mise.toml`の`[env]`でプロバイダー、モデル、エフォート、課金方式を設定します。Git管理対象外の`mise.local.toml`では、各開発者が個別に上書きできます。コピー先に設定がない場合は、タスク内の既定値を使います。モデルとエフォートの組み合わせの利用可否は契約やCLIの設定によって異なるため、必要に応じて変更してください。

以前の`REVIEW_`で始まる設定は、`AWF_REVIEW_`で始まる名前に変更してください。Claude APIキーは`AWF_ANTHROPIC_API_KEY`を使用します。

Codexだけを使う例:

```toml
[env]
AWF_REVIEW_BASE = "main"
AWF_REVIEW_HEAD = "HEAD"
AWF_REVIEW_SECURITY_PROVIDER = "codex"
AWF_REVIEW_SECURITY_MODEL = "gpt-6.1-sol"
AWF_REVIEW_SECURITY_EFFORT = "medium"
AWF_REVIEW_SECURITY_BILLING = "subscription"
AWF_REVIEW_QUALITY_PROVIDER = "codex"
AWF_REVIEW_QUALITY_MODEL = "gpt-6.1-sol"
AWF_REVIEW_QUALITY_EFFORT = "medium"
AWF_REVIEW_QUALITY_BILLING = "subscription"
```

セキュリティにClaude Codeのサブスクリプションを使う例:

```toml
[env]
AWF_REVIEW_SECURITY_PROVIDER = "claude"
AWF_REVIEW_SECURITY_MODEL = "sonnet"
AWF_REVIEW_SECURITY_EFFORT = "medium"
AWF_REVIEW_SECURITY_BILLING = "subscription"
```

Claude APIを使う場合は`AWF_REVIEW_SECURITY_BILLING = "api"`を指定し、秘密情報管理ツールなどを使って実行環境に`AWF_ANTHROPIC_API_KEY`を渡してください。キーは設定ファイルへ記載しないでください。キーはClaudeの子プロセスに限って`ANTHROPIC_API_KEY`として渡します。CodexのAPI課金、Claudeのクラウドプロバイダーやゲートウェイには、このPoCは対応していません。

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
