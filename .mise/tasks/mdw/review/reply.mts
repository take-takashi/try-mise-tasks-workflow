#!/usr/bin/env node
//MISE description="GitHub Pull Request のレビュースレッドへ返信し、必要に応じて resolve する"
//USAGE flag "--pr <url>" help="対象の GitHub Pull Request の URL"
//USAGE flag "--thread <id>" help="返信先のレビュースレッド ID"
//USAGE flag "--body <text>" help="返信本文（--body-file と排他）"
//USAGE flag "--body-file <path>" help="返信本文を読み込むファイルパス（--body と排他）"
//USAGE flag "--resolve" help="返信成功後にスレッドを resolve する"
//USAGE flag "--dry-run" help="外部書き込みを行わず検証結果と返信内容だけを表示する"

import { cli } from "../_lib/cli.mts";
import { verifyOpenPullRequest } from "../_lib/github-pr.mts";
import {
	replyToReviewThread,
	resolveReplyBody,
} from "../_lib/review-threads.mts";

export async function run({
	pr,
	threadId,
	body,
	bodyFile,
	resolve = false,
	dryRun = false,
} = {}) {
	// 返信本文の指定を検証し、必要ならファイルから読み込む（--resolve 単独指定時は本文なしを許可する）。
	const message = resolveReplyBody({ body, bodyFile, resolve });
	// 対象のオープンな Pull Request を確認する。
	const target = await verifyOpenPullRequest(pr);
	// 指定スレッドが対象 PR に属することを確認し、返信（および必要なら resolve）を行う。
	return replyToReviewThread(target, {
		threadId,
		body: message,
		resolve,
		dryRun,
	});
}

// タスクファイルを直接実行したときに、mise が渡した引数で run() を呼び出す。
if (import.meta.main) {
	await cli(
		"GitHub Pull Request のレビュースレッドへ返信し、--resolve 指定時に resolve します。",
		async () => {
			const result = await run({
				pr: process.env.usage_pr,
				threadId: process.env.usage_thread,
				body: process.env.usage_body,
				bodyFile: process.env.usage_body_file,
				resolve: process.env.usage_resolve === "true",
				dryRun: process.env.usage_dry_run === "true",
			});
			console.log(JSON.stringify(result, null, 2));
		},
		{
			usage: [
				"usage_pr",
				"usage_thread",
				"usage_body",
				"usage_body_file",
				"usage_resolve",
				"usage_dry_run",
			],
		},
	);
}
