---
{"id":"ADR-0003","title":"MDW の Node.js 動作要件を .mts と import.meta.main 対応バージョンへ広げる","type":"adr"}
---

# ADR 0003: MDW の Node.js 動作要件を .mts と import.meta.main 対応バージョンへ広げる

- 状態: 採用（[[ADR-0002]] の Node.js バージョン要件を更新）
- 日付: 2026-11-28

## 背景

[[ADR-0002]] では Node.js 24 の最新版を前提としてワークフローの実行基盤を Node.js へ移行した。しかし、MDW を別プロジェクトへコピーして利用する際、コピー先プロジェクトが Node.js 22 LTS など別のバージョンを利用している場合がある。

MDW の実装を確認したところ、利用している標準モジュールは `node:fs`・`node:os`・`node:path`・`node:util`・`node:crypto`・`node:url`・`node:perf_hooks`・`node:child_process` のみであり、新しめの Node.js 仕様への依存は次の 2 点に限られていた。

- `.mts` ファイルの無設定デフォルト実行（Type Stripping）：Node.js v22.18.0 以降および v24 系
- `import.meta.main`：Node.js v22.18.0 以降および v24.2.0 以降

## 決定

- MDW の動作要件を「Node.js 24 固定」から「`.mts` と `import.meta.main` が標準で実行できる Node.js（v22.18.0 以降または v24.2.0 以降）」へ緩和する。
- コピー先プロジェクトの Node.js バージョン管理（`mise.toml`・`.nvmrc`・システム Node 等）には MDW 側から介入しない。Node.js を使わないリポジトリでは、グローバルの `node` や利用者側の設定で用意してもらう。
- 本リポジトリ自身の開発・テスト用 `mise.toml` は引き続き `node = "24"` を維持し、ドキュメント上で「コピー先での動作要件」と「本リポジトリの開発環境」を切り分けて説明する。
- 対応バージョンの判定ロジックを `.mise/tasks/mdw/_lib/node-version.mts` に共通化し、CLI 起動時や診断タスクから再利用できるようにする。

## 影響

- Node.js 22 LTS（v22.18.0 以降）や Node.js 24（v24.2.0 以降）を利用する別プロジェクトでも、Node.js バージョンを切り替えずに MDW を利用できる。
- Node.js v24.0〜v24.1 のように `.mts` は実行できるが `import.meta.main` が未定義のバージョンや、Node.js 23 系・v22.17 以下は非対応として明示し、診断・エラーメッセージで案内できる。
