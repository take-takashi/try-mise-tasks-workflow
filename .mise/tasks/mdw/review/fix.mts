#!/usr/bin/env node
//MISE description="GitHub Pull Request の未解決レビュースレッドを自律修正し、返信と resolve まで実行する"
//USAGE flag "--pr <url>" help="対象の GitHub Pull Request の URL"
//USAGE flag "--issue <number>" help="判断不能時や上限到達時に mdw:wait を付与する Issue 番号（省略時は PR 本文やブランチ名から推測）"
//USAGE flag "--verify <cmd>" help="修正後に実行する検証コマンド（省略時は MDW_REVIEW_FIX_VERIFY を参照）"
//USAGE flag "--max-iterations <n>" help="最大反復回数（1〜5、既定 1）"
//USAGE flag "--dry-run" help="ファイル変更や外部書き込みを行わず対象確認と計画だけを表示する"

import { AgentClient } from "../_lib/agent-client.mts";
import { cli } from "../_lib/cli.mts";
import { verifyOpenPullRequest } from "../_lib/github-pr.mts";
import {
	buildFixPrompt,
	commitAndPushFixes,
	escalateToWait,
	fixPlanSchema,
	hasWorkingTreeChanges,
	reportThreadResults,
	resolveLinkedIssueNumber,
	resolveMaxIterations,
	resolveVerifyCommand,
	runVerificationCommand,
	validateFixPlan,
	validateFixPrompt,
	verifyLocalWorktreeMatchesPr,
} from "../_lib/review-fix.mts";
import { fetchReviewThreads } from "../_lib/review-threads.mts";

export async function run({
	pr,
	issue,
	verify,
	maxIterations: rawMaxIterations,
	dryRun = false,
	cwd = process.env.MISE_ORIGINAL_CWD || process.cwd(),
} = {}) {
	// 反復上限・検証コマンド・修正用プロンプトの妥当性を先に検証する。
	const maxIterations = resolveMaxIterations(rawMaxIterations);
	const verifyCommand = resolveVerifyCommand(verify);
	validateFixPrompt();

	// 対象のオープンな Pull Request を確認し、紐づく Issue 番号を特定する。
	let target = await verifyOpenPullRequest(pr);
	const linkedIssue = resolveLinkedIssueNumber({
		explicitIssue: issue,
		prBody: target.body,
		branchName: target.headRef,
	});

	// 現在の worktree・origin リモート・ブランチ・HEAD が対象 PR と一致することを確認する。
	const worktree = await verifyLocalWorktreeMatchesPr(target, { cwd });

	// 現在の未解決レビュースレッドを取得し、0 件なら何もせず終了する。
	let { threads } = await fetchReviewThreads(target, {
		includeResolved: false,
	});
	if (!threads.length) {
		return {
			pr: target.url,
			status: "no_unresolved_threads",
			issue_number: linkedIssue,
			iterations: [],
			remaining_threads: 0,
			wait_label: { labeled: false, issue_number: linkedIssue },
		};
	}

	// --dry-run の場合は AI 実行・変更・外部書き込みを行わずに計画を返す。
	if (dryRun) {
		return {
			pr: target.url,
			status: "dry_run",
			dry_run: true,
			branch: worktree.branch,
			head_commit: worktree.headCommit,
			issue_number: linkedIssue,
			verify_command: verifyCommand,
			max_iterations: maxIterations,
			unresolved_threads: threads.map((thread) => ({
				id: thread.id,
				path: thread.path,
				line: thread.line,
				is_outdated: thread.is_outdated,
			})),
		};
	}

	// 修正に使う AI CLI の設定と認証を事前に確認する。
	const agent = new AgentClient({ cwd: worktree.root });
	await agent.check(["fix"], { log: console.error });
	const settings = agent.config("fix");

	const iterations = [];
	let needsHumanEscalation = false;

	for (let step = 1; step <= maxIterations; step++) {
		// 静的ルールを先頭にしたプロンプトで AI に修正と結果 JSON の生成を依頼する。
		const prompt = buildFixPrompt(target, threads);
		const { data } = await agent.runWritableStructured(
			settings,
			prompt,
			fixPlanSchema,
		);
		const plan = validateFixPlan(data, threads);

		// AI の報告と作業ツリーの差分有無に矛盾がないか確認する。
		const fixedItems = plan.results.filter((item) => item.status === "fixed");
		const needsHumanItems = plan.results.filter(
			(item) => item.status === "needs_human",
		);
		const changed = await hasWorkingTreeChanges(worktree.root);
		if (fixedItems.length > 0 && !changed) {
			throw new Error(
				"AI が修正済みと報告しましたが、作業ツリーに変更がありません。",
			);
		}
		if (fixedItems.length === 0 && changed) {
			throw new Error(
				"修正対象が 0 件にもかかわらず、作業ツリーに未コミットの変更が残っています。",
			);
		}

		// 修正がある場合は検証コマンドを実行し、失敗時はコミット・プッシュ・resolve せずに中断する。
		let verification = { skipped: true, ok: true, code: 0 };
		let commitSha = null;
		if (fixedItems.length > 0) {
			verification = await runVerificationCommand(verifyCommand, {
				cwd: worktree.root,
			});
			if (!verification.ok) {
				let waitNotice = "";
				try {
					const wait = await escalateToWait(target, linkedIssue);
					if (wait.labeled)
						waitNotice = `（Issue #${wait.issue_number} に mdw:wait を付与しました）`;
				} catch {
					waitNotice = "（mdw:wait ラベルの付与にも失敗しました）";
				}
				throw new Error(
					`検証コマンドが終了コード ${verification.code} で失敗したため、コミット・プッシュ・resolve を中断しました${waitNotice}。`,
				);
			}
			// 検証に通過した修正をコミットして対象 PR ブランチへプッシュする。
			commitSha = await commitAndPushFixes({
				cwd: worktree.root,
				headRef: target.headRef,
				commitMessage: plan.commitMessage,
			});
		}

		// プッシュ完了後に、修正済みスレッドへ返信＆resolve、判断不能スレッドへ保留理由を返信する。
		const replies = await reportThreadResults(target, plan, { commitSha });
		iterations.push({
			iteration: step,
			commit_sha: commitSha,
			verification,
			fixed_count: fixedItems.length,
			needs_human_count: needsHumanItems.length,
			replies,
		});

		// 判断不能スレッドが残っている場合は反復を打ち切り、人間へ引き渡す。
		if (needsHumanItems.length > 0) {
			needsHumanEscalation = true;
			break;
		}

		// 次の反復に備えて PR の最新状態と残存する未解決スレッドを確認する。
		target = await verifyOpenPullRequest(pr);
		({ threads } = await fetchReviewThreads(target, {
			includeResolved: false,
		}));
		if (!threads.length) break;
		if (step < maxIterations) {
			await verifyLocalWorktreeMatchesPr(target, { cwd: worktree.root });
		}
	}

	// 判断不能スレッドが残った、または上限回数後も未解決スレッドが残っている場合は mdw:wait を付与する。
	const remaining = needsHumanEscalation
		? (await fetchReviewThreads(target, { includeResolved: false })).threads
				.length
		: threads.length;
	const shouldWait = needsHumanEscalation || remaining > 0;
	const waitLabel = shouldWait
		? await escalateToWait(target, linkedIssue)
		: { labeled: false, issue_number: linkedIssue };

	return {
		pr: target.url,
		status: needsHumanEscalation
			? "needs_human"
			: remaining > 0
				? "max_iterations_reached"
				: "completed",
		issue_number: linkedIssue,
		iterations,
		remaining_threads: remaining,
		wait_label: waitLabel,
	};
}

// タスクファイルを直接実行したときに、mise が渡した引数で run() を呼び出す。
if (import.meta.main) {
	await cli(
		"GitHub Pull Request の未解決レビュースレッドを自律修正し、返信と resolve まで実行します。",
		async () => {
			const result = await run({
				pr: process.env.usage_pr,
				issue: process.env.usage_issue,
				verify: process.env.usage_verify,
				maxIterations: process.env.usage_max_iterations,
				dryRun: process.env.usage_dry_run === "true",
			});
			console.log(JSON.stringify(result, null, 2));
		},
		{
			usage: [
				"usage_pr",
				"usage_issue",
				"usage_verify",
				"usage_max_iterations",
				"usage_dry_run",
			],
		},
	);
}
