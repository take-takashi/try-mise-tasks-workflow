import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { AgentClient } from "./agent-client.mts";
import { runCommand } from "./command.mts";
import {
	roles,
	validateReview,
	validateReviewPrompts,
} from "./review-data.mts";
import { ReviewWorkspace } from "./review-workspace.mts";
import { review } from "./reviewer.mts";

export async function runRole(role, options = {}) {
	if (!Object.hasOwn(roles, role))
		throw new Error("不明なレビューの観点です: " + role);
	validateReviewPrompts([role]);
	const workspace = await ReviewWorkspace.discover(options.cwd);
	const agent = new AgentClient({ cwd: workspace.root });
	const manifest = await prepare(options, workspace);
	await agent.check([role]);
	return review(role, manifest, workspace, agent);
}

const monotonicSeconds = () => Number(process.hrtime.bigint()) / 1e9;

function decodePath(bytes) {
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	try {
		return { path: decoder.decode(bytes), path_encoding_error: false };
	} catch {
		let result = "";
		for (let i = 0; i < bytes.length; ) {
			const first = bytes[i];
			const size =
				first < 0x80
					? 1
					: first >= 0xc2 && first <= 0xdf
						? 2
						: first >= 0xe0 && first <= 0xef
							? 3
							: first >= 0xf0 && first <= 0xf4
								? 4
								: 0;
			if (size && i + size <= bytes.length) {
				try {
					result += decoder.decode(bytes.subarray(i, i + size));
					i += size;
					continue;
				} catch {}
			}
			result += "\\x" + first.toString(16).padStart(2, "0");
			i++;
		}
		return { path: result, path_encoding_error: true };
	}
}

export async function prepare(options = {}, workspace?: ReviewWorkspace) {
	const baseRef = options.baseRef ?? "main";
	const headRef = options.headRef ?? "HEAD";
	if (
		typeof baseRef !== "string" ||
		!baseRef.trim() ||
		typeof headRef !== "string" ||
		!headRef.trim()
	) {
		throw new Error(
			"baseRef と headRef には空でないコミットまたはブランチを指定してください。",
		);
	}
	workspace ??= await ReviewWorkspace.discover(options.cwd);
	const started = monotonicSeconds();
	workspace.reset();
	const rev = async (ref) =>
		(
			await runCommand(
				["git", "rev-parse", "--verify", "--end-of-options", ref + "^{commit}"],
				{ cwd: workspace.root, timeout: 30 },
			)
		).stdout
			.toString("utf8")
			.trim();
	const base = await rev(baseRef),
		head = await rev(headRef);
	const mergeBase = (
		await runCommand(["git", "merge-base", base, head], {
			cwd: workspace.root,
			timeout: 30,
		})
	).stdout
		.toString("utf8")
		.trim();
	const diff = (
		await runCommand(
			[
				"git",
				"diff",
				"--numstat",
				"-z",
				"--no-renames",
				"--no-ext-diff",
				"--no-textconv",
				mergeBase,
				head,
				"--",
			],
			{ cwd: workspace.root, timeout: 30 },
		)
	).stdout;
	if (!diff.length)
		throw new Error("指定したコミット間にレビュー対象の差分がありません。");
	const files = [];
	for (let position = 0; position < diff.length; ) {
		const end = diff.indexOf(0, position);
		if (end < 0) throw new Error("Gitの変更ファイル一覧を読み取れません。");
		const entry = diff.subarray(position, end);
		position = end + 1;
		if (!entry.length) continue;
		const first = entry.indexOf(9),
			second = entry.indexOf(9, first + 1);
		if (first < 0 || second < 0 || second === entry.length - 1)
			throw new Error("Gitの変更ファイル一覧を読み取れません。");
		const decoded = decodePath(entry.subarray(second + 1));
		files.push({
			path: decoded.path,
			binary:
				entry.subarray(0, first).toString() === "-" &&
				entry.subarray(first + 1, second).toString() === "-",
			path_encoding_error: decoded.path_encoding_error,
		});
	}
	const manifest = {
		run_id: randomUUID(),
		base_ref: baseRef,
		head_ref: headRef,
		base_commit: base,
		merge_base_commit: mergeBase,
		head_commit: head,
		changed_files: files,
		started_monotonic: started,
	};
	workspace.write("manifest.json", manifest);
	return manifest;
}

export function collect(manifest, workspace: ReviewWorkspace) {
	const reviews = Object.keys(roles).map((role) =>
		workspace.read(`${role}.json`),
	);
	const result = summarizeReviews(manifest, reviews, workspace);
	saveReviewSummary(result, workspace);
	return result;
}

export function requireReviewResult(outcome) {
	if (outcome.status === "rejected") throw outcome.reason;
	return outcome.value;
}

export function summarizeReviews(
	manifest,
	reviews,
	workspace: ReviewWorkspace,
) {
	for (const [index, role] of Object.keys(roles).entries()) {
		const item = reviews[index];
		if (
			!item ||
			item.reviewer_id !== role ||
			!isDeepStrictEqual(item.target, manifest)
		)
			throw new Error(`${role} の結果が今回のレビューと一致しません。`);
		validateReview(item.review);
	}
	if (!isDeepStrictEqual(workspace.read("manifest.json"), manifest))
		throw new Error("集約前にレビューの対象が変更されました。");
	return {
		target: manifest,
		duration_seconds:
			Math.round((monotonicSeconds() - manifest.started_monotonic) * 1000) /
			1000,
		reviews,
	};
}

export function saveReviewSummary(result, workspace: ReviewWorkspace) {
	return workspace.write("merged.json", result);
}
