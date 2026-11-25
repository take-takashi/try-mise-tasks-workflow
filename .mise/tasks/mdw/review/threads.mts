#!/usr/bin/env node
//MISE description="GitHub Pull Request の未解決レビュースレッドを取得する"
//USAGE flag "--pr <url>" help="対象の GitHub Pull Request の URL"
//USAGE flag "--all" help="解決済みスレッドも含めて取得する"

import { cli } from "../_lib/cli.mts";
import { verifyOpenPullRequest } from "../_lib/github-pr.mts";
import { fetchReviewThreads } from "../_lib/review-threads.mts";

export async function run({ pr, includeResolved = false } = {}) {
	// 対象のオープンな Pull Request を確認する。
	const target = await verifyOpenPullRequest(pr);
	// GraphQL でレビュースレッド一覧を取得する。
	return fetchReviewThreads(target, { includeResolved });
}

// タスクファイルを直接実行したときに、mise が渡した引数で run() を呼び出す。
if (import.meta.main) {
	await cli(
		"GitHub Pull Request の未解決レビュースレッドを JSON で取得します。",
		async () => {
			const result = await run({
				pr: process.env.usage_pr,
				includeResolved: process.env.usage_all === "true",
			});
			console.log(JSON.stringify(result, null, 2));
		},
		{ usage: ["usage_pr", "usage_all"] },
	);
}
