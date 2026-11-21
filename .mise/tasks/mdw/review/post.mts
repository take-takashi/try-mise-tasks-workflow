#!/usr/bin/env node
//MISE description="評価したレビューを GitHub の Pull Request に投稿する"
//USAGE flag "--pr <url>" help="投稿先の GitHub Pull Request の URL"
//USAGE flag "--dry-run" help="投稿する本文を表示する"
import { loadJudgedReview } from "../_lib/judge.mts";
import {
	postReview,
	renderReview,
	verifyPullRequest,
} from "../_lib/post-review.mts";

export async function run({ pr, dryRun = false } = {}) {
	// 評価結果が、現在の集約済みレビューに基づいていることを確認する。
	const report = await loadJudgedReview();
	// 採用した指摘をまとめ、投稿する本文を組み立てる。
	const body = renderReview(report);
	// プレビューの場合は、組み立てた本文を呼び出し元に返す。
	if (dryRun) return { body };
	// 投稿先の PR と、レビューしたベースとヘッドが一致することを確認する。
	const target = await verifyPullRequest(pr, report.target);
	// レビュー対象のコミットに紐づくコメントとして投稿する。
	return postReview(target, body);
}

// タスクファイルを直接実行したときに、mise が渡した引数で run() を呼び出す。
if (import.meta.main) {
	try {
		const result = await run({
			pr: process.env.usage_pr,
			dryRun: process.env.usage_dry_run === "true",
		});
		// プレビューの本文、または投稿結果を出力する。
		console.log("body" in result ? result.body : JSON.stringify(result));
	} catch (error) {
		// 失敗の理由を標準エラーに出し、終了コードで失敗を伝える。
		console.error(`エラー: ${error.message}`);
		process.exitCode = 1;
	}
}
