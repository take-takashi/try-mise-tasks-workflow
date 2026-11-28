#!/usr/bin/env node
//MISE description="セキュリティの観点でコミットをレビューする"
//USAGE flag "--base <ref>" help="比較元のブランチまたはコミット" default="main"
//USAGE flag "--head <ref>" help="レビュー対象のブランチまたはコミット" default="HEAD"

import { AgentClient } from "../_lib/agent-client.mts";
import { cli, isMainModule } from "../_lib/cli.mts";
import { validateReviewPrompts } from "../_lib/review-data.mts";
import { prepare } from "../_lib/review-steps.mts";
import { ReviewWorkspace } from "../_lib/review-workspace.mts";
import { review } from "../_lib/reviewer.mts";

export async function run(options = {}) {
	// 実行する worktree と AI CLI の実行環境を用意する。
	const workspace = await ReviewWorkspace.discover(options.cwd);
	const agent = new AgentClient({ cwd: workspace.root });
	// レビューに使うプロンプトが揃っているか先に確認する。
	validateReviewPrompts(["security"]);
	// レビューするコミットと変更ファイルを固定する。
	const manifest = await prepare(options, workspace);
	// レビューに使う AI CLI の設定と認証を確認する。
	await agent.check(["security"]);
	// OWASP の視点から認証や入力処理などの安全性を確認する。
	return review("security", manifest, workspace, agent);
}

// タスクファイルを実行したときに run() を呼び出す。import ではレビューを開始しない。
if (isMainModule(import.meta)) {
	// ヘルプの表示と、失敗時の終了コードの設定を cli() に任せる。
	await cli(
		"セキュリティの観点でレビューします。",
		// mise が渡した --base と --head を使ってレビューを開始する。
		() =>
			run({ baseRef: process.env.usage_base, headRef: process.env.usage_head }),
		{ usage: true },
	);
}
