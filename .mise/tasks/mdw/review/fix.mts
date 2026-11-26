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
	assertNoIgnoredFileChanges,
	buildFixPrompt,
	commitAndPushFixes,
	fixPlanSchema,
	listWorkingTreeChanges,
	partitionThreadsForAutoFix,
	reportThreadResults,
	resolveLinkedIssueNumber,
	resolveMaxIterations,
	resolveVerifyCommand,
	runVerificationCommand,
	snapshotIgnoredFiles,
	tryEscalateToWait,
	validateChangedPaths,
	validateFixPlan,
	validateFixPrompt,
	verifyLocalWorktreeMatchesPr,
	writableDenyPaths,
} from "../_lib/review-fix.mts";
import { fetchReviewThreads } from "../_lib/review-threads.mts";

function fallbackRemainingCount(iterations, skippedThreads) {
	const last = iterations[iterations.length - 1];
	const failedFixed = (last?.failed_replies ?? []).filter(
		(item) => item.status === "fixed",
	).length;
	return failedFixed + (last?.needs_human_count ?? 0) + skippedThreads.length;
}

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
			skipped_threads: [],
			iterations: [],
			remaining_threads: 0,
			wait_label: { labeled: false, issue_number: linkedIssue },
		};
	}

	// 投稿者権限と保護対象パスを確認し、自動修正できるスレッドと人間の確認待ちに分ける。
	let { fixableThreads, skippedThreads } = partitionThreadsForAutoFix(threads);

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
			unresolved_threads: fixableThreads.map((thread) => ({
				id: thread.id,
				path: thread.path,
				line: thread.line,
				is_outdated: thread.is_outdated,
			})),
			skipped_threads: skippedThreads,
		};
	}

	// 自動修正対象が 0 件（信頼できない投稿者や保護対象パスのみ）の場合は AI を呼ばずに人間へ引き渡す。
	if (!fixableThreads.length) {
		const waitLabel = await tryEscalateToWait(target, linkedIssue);
		return {
			pr: target.url,
			status: "needs_human",
			issue_number: linkedIssue,
			skipped_threads: skippedThreads,
			iterations: [],
			remaining_threads: threads.length,
			wait_label: waitLabel,
		};
	}

	// 修正に使う AI CLI がシェル禁止の書き込み実行に対応していることと認証を事前に確認する。
	const agent = new AgentClient({ cwd: worktree.root });
	const settings = agent.config("fix");
	agent.assertWritableProvider(settings, "fix");
	await agent.check(["fix"], { log: console.error });

	const iterations = [];
	let needsHumanEscalation = false;
	let partialFailure = false;

	for (let step = 1; step <= maxIterations; step++) {
		try {
			// AI 実行前に .gitignore 対象ファイルの状態を記録し、対象スレッドのファイルだけに書き込みを許可して実行する。
			const ignoredBefore = await snapshotIgnoredFiles(worktree.root);
			const targetWritePaths = [
				...new Set(fixableThreads.map((thread) => thread.path).filter(Boolean)),
			];
			const prompt = buildFixPrompt(target, fixableThreads);
			const { data } = await agent.runWritableStructured(
				settings,
				prompt,
				fixPlanSchema,
				{
					allowWritePaths: targetWritePaths,
					denyWritePaths: writableDenyPaths,
					role: "fix",
				},
			);
			await assertNoIgnoredFileChanges(ignoredBefore, worktree.root);
			const plan = validateFixPlan(data, fixableThreads);

			// AI の報告と作業ツリーの差分有無に矛盾がないか確認する。
			const fixedItems = plan.results.filter((item) => item.status === "fixed");
			const needsHumanItems = plan.results.filter(
				(item) => item.status === "needs_human",
			);
			const changes = await listWorkingTreeChanges(worktree.root);
			const changed = changes.entries.length > 0;
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

			// 修正がある場合は検証コマンド実行前に変更パスの許可範囲と欠落を確認し、検証・コミット・プッシュを行う。
			let verification = {
				skipped: true,
				ok: true,
				code: 0,
				output_excerpt: "",
			};
			let commitSha = null;
			let stagedPaths = [];
			if (fixedItems.length > 0) {
				const fixedIds = new Set(fixedItems.map((item) => item.thread_id));
				const allowedPaths = new Set(
					fixableThreads
						.filter((thread) => fixedIds.has(thread.id))
						.map((thread) => thread.path)
						.filter(Boolean),
				);
				const validated = validateChangedPaths(
					changes,
					allowedPaths,
					worktree.root,
				);
				stagedPaths = validated.paths;
				if (verifyCommand && validated.touchesVerificationCode) {
					throw new Error(
						"テスト・タスク・設定ファイルが変更されたため、自動検証を実行せず中断しました。人間が確認して検証してください。",
					);
				}
				verification = await runVerificationCommand(verifyCommand, {
					cwd: worktree.root,
				});
				if (!verification.ok) {
					const failure = new Error(
						`検証コマンドが終了コード ${verification.code} で失敗したため、コミット・プッシュ・resolve を中断しました。`,
					) as Error & { verificationOutputExcerpt?: string };
					failure.verificationOutputExcerpt = verification.output_excerpt;
					throw failure;
				}
				// 検証に通過した許可対象パスだけをステージ・コミットし、対象 PR ブランチへプッシュする。
				commitSha = await commitAndPushFixes({
					cwd: worktree.root,
					headRef: target.headRef,
					commitMessage: plan.commitMessage,
					paths: stagedPaths,
				});
			}

			// プッシュ完了後に、各スレッドへ個別に返信＆resolve を実行し、部分失敗時も状態を保持する。
			const { replies, failed } = await reportThreadResults(target, plan, {
				commitSha,
			});
			iterations.push({
				iteration: step,
				commit_sha: commitSha,
				staged_paths: stagedPaths,
				verification,
				fixed_count: fixedItems.length,
				needs_human_count: needsHumanItems.length,
				replies,
				failed_replies: failed,
			});

			// 返信や resolve で部分失敗した場合はプッシュ済み SHA と失敗詳細を残して反復を打ち切る。
			if (failed.length > 0) {
				partialFailure = true;
				break;
			}

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
			({ fixableThreads, skippedThreads } =
				partitionThreadsForAutoFix(threads));
			if (!fixableThreads.length) break;
			if (step < maxIterations) {
				await verifyLocalWorktreeMatchesPr(target, { cwd: worktree.root });
			}
		} catch (error) {
			// 反復途中の失敗は一律 mdw:wait を付与し、完了済み反復や未プッシュ SHA を保持した結果を返す。
			const waitLabel = await tryEscalateToWait(target, linkedIssue);
			return {
				pr: target.url,
				status: "failed",
				error: error.message,
				failed_iteration: step,
				unpushed_commit_sha: error?.unpushedCommitSha ?? null,
				verification_output_excerpt: error?.verificationOutputExcerpt ?? "",
				issue_number: linkedIssue,
				skipped_threads: skippedThreads,
				iterations,
				remaining_threads: threads.length,
				wait_label: waitLabel,
			};
		}
	}

	// 未解決スレッド数を確認し、部分失敗・判断不能・対象外スレッド・上限到達時は mdw:wait を付与する。
	let remaining = threads.length;
	if (partialFailure || needsHumanEscalation) {
		try {
			remaining = (await fetchReviewThreads(target, { includeResolved: false }))
				.threads.length;
		} catch {
			remaining = fallbackRemainingCount(iterations, skippedThreads);
		}
	}
	const shouldWait =
		partialFailure ||
		needsHumanEscalation ||
		skippedThreads.length > 0 ||
		remaining > 0;
	const waitLabel = shouldWait
		? await tryEscalateToWait(target, linkedIssue)
		: { labeled: false, issue_number: linkedIssue };

	const status = partialFailure
		? "partial_failure"
		: needsHumanEscalation ||
				(skippedThreads.length > 0 && !fixableThreads.length)
			? "needs_human"
			: remaining > 0
				? "max_iterations_reached"
				: "completed";

	return {
		pr: target.url,
		status,
		issue_number: linkedIssue,
		skipped_threads: skippedThreads,
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
			if (result.status === "failed") {
				console.error(`エラー: ${result.error}`);
				if (result.verification_output_excerpt) {
					console.error(result.verification_output_excerpt);
				}
				process.exitCode = 1;
			} else if (result.status === "partial_failure") {
				process.exitCode = 1;
			}
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
