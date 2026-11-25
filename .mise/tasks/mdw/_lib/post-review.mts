import { isDeepStrictEqual } from "node:util";
import { runCommand } from "./command.mts";
import { asPlainText, githubApi, verifyOpenPullRequest } from "./github-pr.mts";

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffLineRanges(diffText) {
	const ranges = new Map();
	let currentFile = null;
	let remainingOld = 0;
	let remainingNew = 0;
	for (const rawLine of String(diffText).split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (remainingOld > 0 || remainingNew > 0) {
			if (line.startsWith(" ")) {
				remainingOld = Math.max(0, remainingOld - 1);
				remainingNew = Math.max(0, remainingNew - 1);
			} else if (line.startsWith("-")) {
				remainingOld = Math.max(0, remainingOld - 1);
			} else if (line.startsWith("+")) {
				remainingNew = Math.max(0, remainingNew - 1);
			}
			continue;
		}
		if (line.startsWith("diff --git ")) {
			currentFile = null;
			continue;
		}
		if (line.startsWith("+++ ")) {
			if (line === "+++ /dev/null") {
				currentFile = null;
			} else if (line.startsWith("+++ b/")) {
				currentFile = line.slice("+++ b/".length);
				if (!ranges.has(currentFile)) ranges.set(currentFile, []);
			} else {
				currentFile = null;
			}
			continue;
		}
		if (!currentFile || !line.startsWith("@@ ")) continue;
		const match = hunkHeaderPattern.exec(line);
		if (!match) continue;
		const oldCount = match[2] === undefined ? 1 : Number(match[2]);
		const newStart = Number(match[3]);
		const newCount = match[4] === undefined ? 1 : Number(match[4]);
		remainingOld = oldCount;
		remainingNew = newCount;
		if (newCount > 0) {
			ranges.get(currentFile).push({
				start: newStart,
				end: newStart + newCount - 1,
			});
		}
	}
	return ranges;
}

export async function collectDiffLineRanges(target, { cwd }) {
	const { stdout } = await runCommand(
		[
			"git",
			"-c",
			"core.quotepath=false",
			"diff",
			"-U3",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			target.merge_base_commit,
			target.head_commit,
			"--",
		],
		{ cwd, timeout: 30 },
	);
	return parseDiffLineRanges(stdout.toString("utf8"));
}

function isLineInDiff(diffRanges, file, line) {
	if (!diffRanges || !Number.isInteger(line) || line < 1) return false;
	const entries = diffRanges.get(file);
	if (!entries) return false;
	return entries.some((range) => line >= range.start && line <= range.end);
}

export async function verifyPullRequest(url, target) {
	const verified = await verifyOpenPullRequest(url, {
		baseCommit: target.base_commit,
		headCommit: target.head_commit,
	});
	return {
		endpoint: `${verified.endpoint}/reviews`,
		head: target.head_commit,
	};
}

export function renderReview(
	{ target, candidates, decisions, reviewLimitations, judgeLimitations },
	{ diffRanges = null } = {},
) {
	const comments = [];
	const fallback = [];
	let acceptedCount = 0;

	for (const [index, decision] of decisions.entries()) {
		if (decision.verdict !== "accepted") continue;
		acceptedCount++;
		const { finding } = candidates[index];
		if (isLineInDiff(diffRanges, finding.file, finding.line)) {
			comments.push({
				path: finding.file,
				line: finding.line,
				side: "RIGHT",
				body: asPlainText(
					[
						`[${finding.severity}] ${finding.title}`,
						`判定の根拠: ${decision.reason}`,
						`修正案: ${finding.recommendation}`,
					].join("\n"),
				),
			});
		} else {
			fallback.push(
				asPlainText(
					[
						`[${finding.severity}] ${finding.title}`,
						`${finding.file}:${finding.line}`,
						`判定の根拠: ${decision.reason}`,
						`修正案: ${finding.recommendation}`,
					].join("\n"),
				),
			);
		}
	}

	const summaryLine =
		acceptedCount > 0 && comments.length > 0
			? `採用 ${acceptedCount} 件 / 評価 ${decisions.length} 件（インライン ${comments.length} 件、本文記載 ${fallback.length} 件）`
			: `採用 ${acceptedCount} 件 / 評価 ${decisions.length} 件`;

	const lines = [
		"## MDW レビュー",
		"",
		`対象コミット \`${target.head_commit}\``,
		"",
		summaryLine,
		"",
		...fallback.flatMap((item) => [item, ""]),
	];
	if (reviewLimitations || judgeLimitations)
		lines.push(
			`確認範囲の制限が報告されています（レビュー ${reviewLimitations} 件、Judge ${judgeLimitations} 件）。`,
		);
	return {
		body: lines.join("\n").trimEnd(),
		comments,
		inlineCount: comments.length,
		fallbackCount: fallback.length,
	};
}

export function formatDryRunReview({ body, comments }) {
	if (!comments.length) return body;
	const parts = [body, "", "### インラインコメント予定", ""];
	for (const comment of comments) {
		parts.push(`- \`${comment.path}:${comment.line}\` (${comment.side})`);
		parts.push(comment.body);
		parts.push("");
	}
	return parts.join("\n").trimEnd();
}

function normalizeReviewComments(comments) {
	return comments
		.map((item) => ({
			path: item.path,
			line: item.line ?? item.original_line ?? null,
			side: item.side ?? "RIGHT",
			body: item.body,
		}))
		.sort((a, b) =>
			`${a.path}:${a.line}:${a.side}:${a.body}`.localeCompare(
				`${b.path}:${b.line}:${b.side}:${b.body}`,
			),
		);
}

async function matchesExistingComments(endpoint, reviewId, expectedComments) {
	if (reviewId === undefined || reviewId === null)
		return expectedComments.length === 0;
	const pages = await githubApi(`${endpoint}/${reviewId}/comments`, [
		"--paginate",
		"--slurp",
	]);
	const actual = pages.flat();
	return isDeepStrictEqual(
		normalizeReviewComments(actual),
		normalizeReviewComments(expectedComments),
	);
}

export async function postReview({ endpoint, head }, payload) {
	const body = typeof payload === "string" ? payload : payload.body;
	const comments = typeof payload === "string" ? [] : (payload.comments ?? []);
	const fallbackCount =
		typeof payload === "string" ? 0 : (payload.fallbackCount ?? 0);

	const pages = await githubApi(endpoint, ["--paginate", "--slurp"]);
	const candidates = pages
		.flat()
		.filter(
			(item) =>
				item.state === "COMMENTED" &&
				item.commit_id === head &&
				item.body === body,
		);
	for (const existing of candidates) {
		if (await matchesExistingComments(endpoint, existing.id, comments)) {
			return {
				url: existing.html_url,
				alreadyPosted: true,
				inlineCount: comments.length,
				fallbackCount,
			};
		}
	}

	const requestBody = {
		commit_id: head,
		event: "COMMENT",
		body,
		...(comments.length ? { comments } : {}),
	};
	const result = await githubApi(
		endpoint,
		["--method", "POST", "--input", "-"],
		JSON.stringify(requestBody),
	);
	if (typeof result?.html_url !== "string")
		throw new Error("GitHub からレビューの URL が返されませんでした。");
	return {
		url: result.html_url,
		alreadyPosted: false,
		inlineCount: comments.length,
		fallbackCount,
	};
}
