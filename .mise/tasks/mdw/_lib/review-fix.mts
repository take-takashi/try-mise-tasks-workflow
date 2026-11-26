import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { timeoutSeconds } from "./agent-client.mts";
import { runCommand } from "./command.mts";
import { addIssueLabels, asPlainText } from "./github-pr.mts";
import { replyToReviewThread } from "./review-threads.mts";

const defaultPromptDir = fileURLToPath(
	new URL("../prompts/review", import.meta.url),
);
const maxAllowedIterations = 5;
const validStatuses = ["fixed", "needs_human"];

function hasControlChar(value) {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

export const fixPlanSchema = {
	type: "object",
	additionalProperties: false,
	required: ["commit_message", "results"],
	properties: {
		commit_message: { type: "string" },
		results: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["thread_id", "status", "summary"],
				properties: {
					thread_id: { type: "string", minLength: 1 },
					status: { type: "string", enum: validStatuses },
					summary: { type: "string", minLength: 1 },
				},
			},
		},
	},
};

export function resolveMaxIterations(raw) {
	if (raw === undefined || raw === null || raw === "") return 1;
	const text = String(raw).trim();
	if (!/^\d+$/.test(text))
		throw new Error(
			`--max-iterations には 1〜${maxAllowedIterations} の整数を指定してください。`,
		);
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value < 1 || value > maxAllowedIterations)
		throw new Error(
			`--max-iterations には 1〜${maxAllowedIterations} の整数を指定してください。`,
		);
	return value;
}

export function resolveVerifyCommand(flagValue, env = process.env) {
	if (flagValue !== undefined && flagValue !== null) {
		if (typeof flagValue !== "string" || !flagValue.trim())
			throw new Error("--verify には空でないコマンドを指定してください。");
		return flagValue.trim();
	}
	if (
		typeof env.MDW_REVIEW_FIX_VERIFY === "string" &&
		env.MDW_REVIEW_FIX_VERIFY.trim()
	) {
		return env.MDW_REVIEW_FIX_VERIFY.trim();
	}
	return null;
}

export function resolveLinkedIssueNumber({
	explicitIssue,
	prBody = "",
	branchName = "",
} = {}) {
	if (
		explicitIssue !== undefined &&
		explicitIssue !== null &&
		explicitIssue !== ""
	) {
		const text = String(explicitIssue).trim();
		if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
			throw new Error("--issue には正の整数を指定してください。");
		return Number(text);
	}
	const bodyMatch =
		typeof prBody === "string"
			? /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/i.exec(
					prBody,
				)
			: null;
	if (bodyMatch) return Number(bodyMatch[1]);
	const branchMatch =
		typeof branchName === "string"
			? /^[^/]+\/([1-9]\d*)(?:-|$)/.exec(branchName)
			: null;
	if (branchMatch) return Number(branchMatch[1]);
	return null;
}

export function parseGithubRepoFromRemote(remoteUrl) {
	if (typeof remoteUrl !== "string") return null;
	const trimmed = remoteUrl.trim();
	const patterns = [
		/^https:\/\/github\.com\/([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+?)(?:\.git)?\/?$/i,
		/^git@github\.com:([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+?)(?:\.git)?$/i,
		/^ssh:\/\/git@github\.com\/([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+?)(?:\.git)?\/?$/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(trimmed);
		if (match && match[2] !== "." && match[2] !== "..") {
			return { owner: match[1], repo: match[2] };
		}
	}
	return null;
}

export function validateFixPrompt({ promptDir = defaultPromptDir } = {}) {
	const file = path.join(promptDir, "fix.md");
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8").trim();
	} catch {
		throw new Error("修正用プロンプトを読み取れません: fix.md");
	}
	if (!content) throw new Error("修正用プロンプトが空です: fix.md");
	return content;
}

// プレフィックスキャッシュを活かすため、静的な修正ルールを先頭、PR とスレッド一覧（動的）を末尾に配置する。
export function buildFixPrompt(
	target,
	threads,
	{ promptDir = defaultPromptDir } = {},
) {
	const staticGuide = validateFixPrompt({ promptDir });
	const dynamicContext = [
		"## 修正対象",
		`Pull Request: ${target.url}`,
		`ブランチ: ${target.headRef}`,
		`現在のヘッドコミット: ${target.headSha}`,
		`未解決レビュースレッド一覧: ${JSON.stringify(threads)}`,
	].join("\n");
	return `${staticGuide}\n\n${dynamicContext}`;
}

export async function verifyLocalWorktreeMatchesPr(
	target,
	{ cwd = process.env.MISE_ORIGINAL_CWD || process.cwd() } = {},
) {
	const root = (
		await runCommand(["git", "rev-parse", "--show-toplevel"], {
			cwd,
			timeout: 30,
		})
	).stdout
		.toString("utf8")
		.trim();
	const remoteUrl = (
		await runCommand(["git", "remote", "get-url", "origin"], {
			cwd: root,
			timeout: 30,
		})
	).stdout
		.toString("utf8")
		.trim();
	const remoteRepo = parseGithubRepoFromRemote(remoteUrl);
	if (
		!remoteRepo ||
		remoteRepo.owner.toLowerCase() !== target.owner.toLowerCase() ||
		remoteRepo.repo.toLowerCase() !== target.repo.toLowerCase()
	) {
		throw new Error(
			"現在のリポジトリの origin が指定された Pull Request のリポジトリと一致しません。",
		);
	}
	const status = (
		await runCommand(["git", "status", "--porcelain"], {
			cwd: root,
			timeout: 30,
		})
	).stdout
		.toString("utf8")
		.trim();
	if (status) {
		throw new Error(
			"作業ツリーに未コミットの変更があります。クリーンな状態で実行してください。",
		);
	}
	const branch = (
		await runCommand(["git", "symbolic-ref", "--short", "HEAD"], {
			cwd: root,
			timeout: 30,
		})
	).stdout
		.toString("utf8")
		.trim();
	if (!target.headRef || branch !== target.headRef) {
		throw new Error(
			`現在のブランチ（${branch}）が Pull Request のヘッドブランチ（${target.headRef}）と一致しません。`,
		);
	}
	const headCommit = (
		await runCommand(["git", "rev-parse", "HEAD"], {
			cwd: root,
			timeout: 30,
		})
	).stdout
		.toString("utf8")
		.trim();
	if (headCommit !== target.headSha) {
		throw new Error(
			"ローカルの HEAD が Pull Request の最新コミットと一致しません。最新を取得してから実行してください。",
		);
	}
	return { root, branch, headCommit };
}

export function validateFixPlan(data, threads) {
	if (
		!data ||
		typeof data !== "object" ||
		Array.isArray(data) ||
		!isDeepStrictEqual(Object.keys(data).sort(), ["commit_message", "results"])
	) {
		throw new Error("修正結果の JSON 形式が不正です。");
	}
	if (typeof data.commit_message !== "string") {
		throw new Error("commit_message は文字列で指定してください。");
	}
	if (!Array.isArray(data.results) || data.results.length !== threads.length) {
		throw new Error(
			"未解決スレッドごとに 1 件ずつ修正結果を返す必要があります。",
		);
	}
	const expectedIds = new Set(threads.map((thread) => thread.id));
	const byId = new Map();
	for (const item of data.results) {
		if (
			!item ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			!isDeepStrictEqual(Object.keys(item).sort(), [
				"status",
				"summary",
				"thread_id",
			]) ||
			typeof item.thread_id !== "string" ||
			!expectedIds.delete(item.thread_id) ||
			!validStatuses.includes(item.status) ||
			typeof item.summary !== "string" ||
			!item.summary.trim()
		) {
			throw new Error(
				"修正結果に未知のスレッド ID、重複、または不正な値があります。",
			);
		}
		byId.set(item.thread_id, {
			thread_id: item.thread_id,
			status: item.status,
			summary: item.summary.trim(),
		});
	}
	const ordered = threads.map((thread) => byId.get(thread.id));
	const fixedCount = ordered.filter((item) => item.status === "fixed").length;
	const commitMessage = data.commit_message.trim();
	if (fixedCount > 0) {
		if (
			!commitMessage ||
			commitMessage.length > 200 ||
			hasControlChar(commitMessage)
		) {
			throw new Error(
				"修正がある場合は 1 行の有効な commit_message を指定してください。",
			);
		}
	}
	return { commitMessage, results: ordered };
}

export async function hasWorkingTreeChanges(cwd) {
	const { stdout } = await runCommand(["git", "status", "--porcelain"], {
		cwd,
		timeout: 30,
	});
	return Boolean(stdout.toString("utf8").trim());
}

export async function runVerificationCommand(
	verifyCommand,
	{ cwd, env = process.env } = {},
) {
	if (!verifyCommand) return { skipped: true, ok: true, code: 0 };
	const timeout = timeoutSeconds(env);
	const { code, signal } = await runCommand(["sh", "-c", verifyCommand], {
		cwd,
		env,
		timeout,
		allowNonZero: true,
	});
	return {
		skipped: false,
		ok: code === 0,
		code: code ?? signal,
	};
}

export async function commitAndPushFixes({ cwd, headRef, commitMessage }) {
	await runCommand(["git", "add", "-A"], { cwd, timeout: 30 });
	const staged = (
		await runCommand(["git", "diff", "--cached", "--name-only"], {
			cwd,
			timeout: 30,
		})
	).stdout
		.toString("utf8")
		.trim();
	if (!staged) {
		throw new Error("コミット対象の差分がありません。");
	}
	await runCommand(["git", "commit", "--file=-"], {
		cwd,
		input: `${commitMessage}\n`,
		timeout: 30,
	});
	const commitSha = (
		await runCommand(["git", "rev-parse", "HEAD"], {
			cwd,
			timeout: 30,
		})
	).stdout
		.toString("utf8")
		.trim();
	try {
		await runCommand(["git", "push", "origin", `HEAD:refs/heads/${headRef}`], {
			cwd,
			timeout: 60,
		});
	} catch (error) {
		throw new Error(
			`コミット（${commitSha.slice(0, 7)}）は作成されましたが、プッシュに失敗したため resolve を中断しました: ${error.message}`,
		);
	}
	return commitSha;
}

export async function reportThreadResults(target, plan, { commitSha }) {
	const replies = [];
	const shortSha = commitSha ? commitSha.slice(0, 7) : null;
	for (const item of plan.results) {
		if (item.status === "fixed") {
			if (!shortSha)
				throw new Error("修正コミット SHA が未確定のため resolve できません。");
			const body = [
				`コミット \`${shortSha}\` で修正しました。`,
				"",
				asPlainText(item.summary),
			].join("\n");
			const result = await replyToReviewThread(target, {
				threadId: item.thread_id,
				body,
				resolve: true,
			});
			replies.push({ ...result, status: "fixed" });
		} else {
			const body = [
				"自動修正を保留しました（人間の確認待ち）。",
				"",
				asPlainText(item.summary),
			].join("\n");
			const result = await replyToReviewThread(target, {
				threadId: item.thread_id,
				body,
				resolve: false,
			});
			replies.push({ ...result, status: "needs_human" });
		}
	}
	return replies;
}

export async function escalateToWait(target, issueNumber) {
	if (!issueNumber) return { labeled: false, issue_number: null };
	await addIssueLabels(target, issueNumber, ["mdw:wait"]);
	return { labeled: true, issue_number: issueNumber };
}
