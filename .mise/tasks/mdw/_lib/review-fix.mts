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
const trustedAuthorAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const protectedTopLevelDirs = new Set([
	".git",
	".github",
	".mdw",
	".claude",
	".agents",
]);
export const writableDenyPaths = [
	...protectedTopLevelDirs,
	"mise.toml",
	".mise.toml",
	".env",
];
const verificationTopLevelDirs = new Set(["tests", "test", ".mise", "scripts"]);
const verificationConfigFiles = new Set([
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"biome.json",
	"biome.jsonc",
	"tsconfig.json",
]);
const secretEnvPattern =
	/(?:^|_)(?:TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL)(?:$|_)/i;
const explicitSecretEnvKeys = new Set([
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"OPENAI_API_KEY",
	"CODEX_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"MDW_ANTHROPIC_API_KEY",
	"AWF_ANTHROPIC_API_KEY",
	"REVIEW_ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"NPM_TOKEN",
	"NODE_AUTH_TOKEN",
]);

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

function parseSafePositiveInt(raw) {
	const text = String(raw).trim();
	if (!/^[1-9]\d*$/.test(text)) return null;
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : null;
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
		const parsed = parseSafePositiveInt(explicitIssue);
		if (parsed === null)
			throw new Error("--issue には正の整数を指定してください。");
		return parsed;
	}
	const bodyMatch =
		typeof prBody === "string"
			? /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/i.exec(
					prBody,
				)
			: null;
	const bodyIssue = bodyMatch ? parseSafePositiveInt(bodyMatch[1]) : null;
	if (bodyIssue !== null) return bodyIssue;
	const branchMatch =
		typeof branchName === "string"
			? /^[^/]+\/([1-9]\d*)(?:-|$)/.exec(branchName)
			: null;
	const branchIssue = branchMatch ? parseSafePositiveInt(branchMatch[1]) : null;
	if (branchIssue !== null) return branchIssue;
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

export function isProtectedPath(filePath) {
	if (
		typeof filePath !== "string" ||
		!filePath ||
		filePath.startsWith("/") ||
		filePath.includes("\\") ||
		hasControlChar(filePath)
	) {
		return true;
	}
	const segments = filePath.split("/");
	if (segments.some((part) => !part || part === "." || part === "..")) {
		return true;
	}
	if (protectedTopLevelDirs.has(segments[0])) return true;
	if (segments.includes(".git")) return true;
	const base = segments[segments.length - 1].toLowerCase();
	if (
		base === "mise.toml" ||
		base === ".mise.toml" ||
		/^mise\..+\.toml$/.test(base) ||
		/^\.env(?:\..+)?$/.test(base)
	) {
		return true;
	}
	return false;
}

export function isVerificationExecutablePath(filePath) {
	if (typeof filePath !== "string" || !filePath) return true;
	const segments = filePath.split("/");
	if (verificationTopLevelDirs.has(segments[0])) return true;
	const base = segments[segments.length - 1].toLowerCase();
	if (verificationConfigFiles.has(base)) return true;
	return false;
}

export function partitionThreadsForAutoFix(threads) {
	const fixableThreads = [];
	const skippedThreads = [];
	for (const thread of threads) {
		const comments = Array.isArray(thread.comments) ? thread.comments : [];
		const allTrusted =
			!thread.comments_truncated &&
			comments.length > 0 &&
			comments.every((comment) =>
				trustedAuthorAssociations.has(comment.author_association),
			);
		if (!allTrusted) {
			skippedThreads.push({
				id: thread.id,
				path: thread.path ?? null,
				line: thread.line ?? null,
				reason: "untrusted_author",
			});
			continue;
		}
		if (
			typeof thread.path !== "string" ||
			!thread.path.trim() ||
			isProtectedPath(thread.path)
		) {
			skippedThreads.push({
				id: thread.id,
				path: thread.path ?? null,
				line: thread.line ?? null,
				reason: "protected_path",
			});
			continue;
		}
		fixableThreads.push(thread);
	}
	return { fixableThreads, skippedThreads };
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

async function runGit(args, { cwd, input = "", timeout = 30 }) {
	const { stdout, stderr, code, signal } = await runCommand(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		input,
		timeout,
		allowNonZero: true,
	});
	if (code !== 0) {
		const detail = summarizeCommandOutput(stdout, stderr, 300);
		throw new Error(
			`git ${args[0]} が終了コード ${code ?? signal} で失敗しました${detail ? `: ${detail}` : ""}。`,
		);
	}
	return stdout;
}

export async function verifyLocalWorktreeMatchesPr(
	target,
	{ cwd = process.env.MISE_ORIGINAL_CWD || process.cwd() } = {},
) {
	const root = (await runGit(["rev-parse", "--show-toplevel"], { cwd }))
		.toString("utf8")
		.trim();
	const remoteUrl = (
		await runGit(["remote", "get-url", "origin"], { cwd: root })
	)
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
	const status = (await runGit(["status", "--porcelain"], { cwd: root }))
		.toString("utf8")
		.trim();
	if (status) {
		throw new Error(
			"作業ツリーに未コミットの変更があります。クリーンな状態で実行してください。",
		);
	}
	const branch = (
		await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: root })
	)
		.toString("utf8")
		.trim();
	if (!target.headRef || branch !== target.headRef) {
		throw new Error(
			`現在のブランチ（${branch}）が Pull Request のヘッドブランチ（${target.headRef}）と一致しません。`,
		);
	}
	const headCommit = (await runGit(["rev-parse", "HEAD"], { cwd: root }))
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

export async function listWorkingTreeChanges(cwd) {
	const raw = (
		await runGit(["status", "--porcelain", "-z", "-uall"], { cwd })
	).toString("utf8");
	if (!raw) return { entries: [], paths: [] };
	const tokens = raw.split("\0");
	if (tokens[tokens.length - 1] === "") tokens.pop();
	const entries = [];
	const seen = new Set();
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.length < 4 || token[2] !== " ") {
			throw new Error("git status の出力を解析できません。");
		}
		const status = token.slice(0, 2);
		const filePath = token.slice(3);
		let originalPath = null;
		if (
			status[0] === "R" ||
			status[1] === "R" ||
			status[0] === "C" ||
			status[1] === "C"
		) {
			originalPath = tokens[++index] ?? null;
		}
		entries.push({ status, path: filePath, originalPath });
		seen.add(filePath);
		if (originalPath) seen.add(originalPath);
	}
	return { entries, paths: [...seen] };
}

export async function snapshotIgnoredFiles(cwd) {
	const raw = (
		await runGit(["status", "--porcelain", "-z", "-uall", "--ignored"], { cwd })
	).toString("utf8");
	const snapshot = new Map<string, string>();
	if (!raw) return snapshot;
	const tokens = raw.split("\0");
	if (tokens[tokens.length - 1] === "") tokens.pop();
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.length < 4 || token[2] !== " ") continue;
		const status = token.slice(0, 2);
		const filePath = token.slice(3);
		if (
			status[0] === "R" ||
			status[1] === "R" ||
			status[0] === "C" ||
			status[1] === "C"
		) {
			index++;
			continue;
		}
		if (status !== "!!") continue;
		const absolute = path.join(cwd, filePath);
		try {
			const stat = fs.lstatSync(absolute);
			snapshot.set(
				filePath,
				`${stat.isSymbolicLink() ? "L" : "F"}:${stat.size}:${stat.mtimeMs}`,
			);
		} catch {
			snapshot.set(filePath, "missing");
		}
	}
	return snapshot;
}

export async function assertNoIgnoredFileChanges(beforeSnapshot, cwd) {
	const afterSnapshot = await snapshotIgnoredFiles(cwd);
	const changed = [];
	for (const [filePath, sig] of afterSnapshot.entries()) {
		if (beforeSnapshot.get(filePath) !== sig) changed.push(filePath);
	}
	for (const filePath of beforeSnapshot.keys()) {
		if (!afterSnapshot.has(filePath)) changed.push(filePath);
	}
	if (changed.length > 0) {
		throw new Error(
			`Git 除外対象（.gitignore）のファイルが変更されたため中断しました: ${changed.slice(0, 5).join(", ")}`,
		);
	}
}

export function validateChangedPaths(changes, allowedPaths, cwd) {
	const validated = [];
	const seen = new Set();
	for (const entry of changes.entries) {
		if (entry.status === "??") {
			throw new Error(
				`新規ファイルの追加（${entry.path}）は自動修正では許可されていません。`,
			);
		}
		const involved = entry.originalPath
			? [entry.path, entry.originalPath]
			: [entry.path];
		for (const filePath of involved) {
			if (isProtectedPath(filePath)) {
				throw new Error(
					`保護対象ファイル（${filePath}）の変更は自動修正では許可されていません。`,
				);
			}
			if (!allowedPaths.has(filePath)) {
				throw new Error(
					`対象スレッド外のファイル（${filePath}）が変更されたため中断しました。`,
				);
			}
			const absolute = path.join(cwd, filePath);
			try {
				if (fs.lstatSync(absolute).isSymbolicLink()) {
					throw new Error(
						`シンボリックリンク（${filePath}）の変更は自動修正では許可されていません。`,
					);
				}
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
			if (!seen.has(filePath)) {
				seen.add(filePath);
				validated.push(filePath);
			}
		}
	}
	const missing = [...allowedPaths].filter((filePath) => !seen.has(filePath));
	if (missing.length > 0) {
		throw new Error(
			`AI が修正済みと報告した対象ファイルに変更がありません: ${missing.join(", ")}`,
		);
	}
	return {
		paths: validated,
		touchesVerificationCode: validated.some(isVerificationExecutablePath),
	};
}

export function verificationEnvironment(environment = process.env) {
	const sanitized = {};
	for (const [key, value] of Object.entries(environment)) {
		if (explicitSecretEnvKeys.has(key) || secretEnvPattern.test(key)) continue;
		sanitized[key] = value;
	}
	return sanitized;
}

function summarizeCommandOutput(stdout, stderr, maxChars = 500) {
	const combined = [stderr.toString("utf8"), stdout.toString("utf8")]
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n");
	if (!combined) return "";
	return combined.length > maxChars
		? `…${combined.slice(combined.length - maxChars)}`
		: combined;
}

export async function runVerificationCommand(
	verifyCommand,
	{ cwd, env = process.env } = {},
) {
	if (!verifyCommand)
		return { skipped: true, ok: true, code: 0, output_excerpt: "" };
	const timeout = timeoutSeconds(env);
	const { stdout, stderr, code, signal } = await runCommand(
		["sh", "-c", verifyCommand],
		{
			cwd,
			env: verificationEnvironment(env),
			timeout,
			allowNonZero: true,
		},
	);
	return {
		skipped: false,
		ok: code === 0,
		code: code ?? signal,
		output_excerpt: code === 0 ? "" : summarizeCommandOutput(stdout, stderr),
	};
}

export async function commitAndPushFixes({
	cwd,
	headRef,
	commitMessage,
	paths,
}) {
	if (!Array.isArray(paths) || paths.length === 0) {
		throw new Error("ステージ対象のファイルパスがありません。");
	}
	const allowed = new Set(paths);
	await runGit(["add", "--", ...paths], { cwd });
	const stagedRaw = (
		await runGit(["diff", "--cached", "--name-only", "-z"], { cwd })
	).toString("utf8");
	const staged = stagedRaw.split("\0").filter(Boolean);
	if (!staged.length) {
		throw new Error("コミット対象の差分がありません。");
	}
	const unexpected = staged.filter((filePath) => !allowed.has(filePath));
	if (unexpected.length) {
		throw new Error(
			`許可範囲外のファイルがステージされました: ${unexpected.join(", ")}`,
		);
	}
	await runGit(["commit", "--file=-"], {
		cwd,
		input: `${commitMessage}\n`,
	});
	const commitSha = (await runGit(["rev-parse", "HEAD"], { cwd }))
		.toString("utf8")
		.trim();
	try {
		await runGit(["push", "origin", `HEAD:refs/heads/${headRef}`], {
			cwd,
			timeout: 60,
		});
	} catch (error) {
		const wrapped = new Error(
			`コミット（${commitSha.slice(0, 7)}）は作成されましたが、プッシュに失敗したため resolve を中断しました: ${error.message}`,
		) as Error & { unpushedCommitSha?: string };
		wrapped.unpushedCommitSha = commitSha;
		throw wrapped;
	}
	return commitSha;
}

export async function reportThreadResults(target, plan, { commitSha }) {
	const replies = [];
	const failed = [];
	const shortSha = commitSha ? commitSha.slice(0, 7) : null;
	for (const item of plan.results) {
		const isFixed = item.status === "fixed";
		if (isFixed && !shortSha) {
			throw new Error("修正コミット SHA が未確定のため resolve できません。");
		}
		const body = isFixed
			? [
					`コミット \`${shortSha}\` で修正しました。`,
					"",
					asPlainText(item.summary),
				].join("\n")
			: [
					"自動修正を保留しました（人間の確認待ち）。",
					"",
					asPlainText(item.summary),
				].join("\n");
		try {
			const result = await replyToReviewThread(target, {
				threadId: item.thread_id,
				body,
				resolve: isFixed,
			});
			replies.push({ ...result, status: item.status, ok: true });
		} catch (error) {
			const replied = Boolean(error?.replied);
			failed.push({
				thread_id: item.thread_id,
				status: item.status,
				ok: false,
				replied,
				error: error.message,
				recovery_command: isFixed
					? replied
						? `mise run mdw:review:reply --pr ${target.url} --thread ${item.thread_id} --resolve`
						: `mise run mdw:review:reply --pr ${target.url} --thread ${item.thread_id} --resolve --body "コミット ${shortSha} で修正しました。"`
					: `mise run mdw:review:reply --pr ${target.url} --thread ${item.thread_id} --body "自動修正を保留しました。"`,
			});
		}
	}
	return { replies, failed };
}

export async function escalateToWait(target, issueNumber) {
	if (!issueNumber) return { labeled: false, issue_number: null };
	await addIssueLabels(target, issueNumber, ["mdw:wait"]);
	return { labeled: true, issue_number: issueNumber };
}

export async function tryEscalateToWait(
	target,
	issueNumber,
	{ warn = console.error } = {},
) {
	if (!issueNumber) return { labeled: false, issue_number: null };
	try {
		return await escalateToWait(target, issueNumber);
	} catch (error) {
		warn(
			`警告: Issue #${issueNumber} への mdw:wait ラベル付与に失敗しました: ${error.message}`,
		);
		return {
			labeled: false,
			issue_number: issueNumber,
			error: error.message,
		};
	}
}
