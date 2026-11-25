#!/usr/bin/env node
//MISE description="MDWのレビュー ワークフローを実行する"
//USAGE flag "--base <ref>" help="比較元のブランチまたはコミット" default="main"
//USAGE flag "--head <ref>" help="レビュー対象のブランチまたはコミット" default="HEAD"

import { AgentClient } from "./_lib/agent-client.mts";
import { cli } from "./_lib/cli.mts";
import {
	prepare,
	requireReviewResult,
	saveReviewSummary,
	summarizeReviews,
} from "./_lib/review-steps.mts";
import { ReviewWorkspace } from "./_lib/review-workspace.mts";
import { review } from "./_lib/reviewer.mts";

export async function run(options = {}) {
	// 実行する worktree と AI CLI の実行環境を用意する。
	const workspace = await ReviewWorkspace.discover(options.cwd);
	const agent = new AgentClient({ cwd: workspace.root });
	// 両方のレビューが同じ差分を見るように、対象のコミットと変更ファイルを固定する。
	const manifest = await prepare(options, workspace);
	// レビューに使う AI CLI の設定と認証を確認する。
	await agent.check();

	// 三つのレビューを並列に実行し、すべての成否が確定するまで待つ。
	const outcomes = await Promise.allSettled([
		// OWASP の視点から認証や入力処理などの安全性を確認する。
		review("security", manifest, workspace, agent),
		// 設計方針との整合や運用・障害耐性の問題を確認する。
		review("architecture", manifest, workspace, agent),
		// 変更の正しさやテスト観点の妥当性を確認する。
		review("quality", manifest, workspace, agent),
	]);

	// 失敗したレビューがあれば、エラーにして集約を中断する。
	const reviews = outcomes.map(requireReviewResult);
	// 対象が一致することを確かめ、観点ごとの結果をまとめる。
	const result = summarizeReviews(manifest, reviews, workspace);
	// 集約結果を .reviews/merged.json に保存する。
	const file = saveReviewSummary(result, workspace);
	// 保存先とレビュー全体の所要時間を表示する。
	console.log(
		`集約結果を保存しました: ${file}（全体: ${result.duration_seconds.toFixed(3)}秒）`,
	);
	return result;
}

// mise などからタスクファイルを直接実行したときは、run() を呼び出す。
// 別のワークフローから run() を import しただけでは、レビューは始まらない。
if (import.meta.main) {
	// ヘルプの表示と、失敗時の終了コードの設定を cli() に任せる。
	await cli(
		"セキュリティ、アーキテクチャ・運用、品質の観点で並列レビューします。",
		// mise が渡した --base と --head を使ってレビューを開始する。
		() =>
			run({ baseRef: process.env.usage_base, headRef: process.env.usage_head }),
		{ usage: true },
	);
}
