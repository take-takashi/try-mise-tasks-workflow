import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const roles = {
	security: "認証、認可、入力処理、情報漏えいなどのセキュリティ上の欠陥",
	architecture:
		"docs/intent.md・ADRとの整合、責務分離、障害耐性などのアーキテクチャ・運用上の欠陥",
	quality:
		"正しさ、回帰、例外処理、テスト観点（testent）の妥当性などの品質上の欠陥",
};

const defaultPromptDir = fileURLToPath(
	new URL("../prompts/review", import.meta.url),
);

function readReviewPromptFile(promptDir, filename) {
	const file = path.join(promptDir, filename);
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8").trim();
	} catch {
		throw new Error(`レビュー用プロンプトを読み取れません: ${filename}`);
	}
	if (!content) throw new Error(`レビュー用プロンプトが空です: ${filename}`);
	return content;
}

// プレフィックスキャッシュを活かすため、全ロール共通の静的ルール → ロール固有の静的観点 → 動的コンテキストの順に組み立てる。
export function buildReviewPrompt(
	role,
	manifest,
	{ promptDir = defaultPromptDir } = {},
) {
	if (!Object.hasOwn(roles, role))
		throw new Error(`不明なレビューの観点です: ${role}`);
	const base = readReviewPromptFile(promptDir, "base.md");
	const roleGuide = readReviewPromptFile(promptDir, `${role}.md`);
	const before = manifest.merge_base_commit;
	const after = manifest.head_commit;
	const dynamicContext = [
		"## レビュー対象",
		`対象コミット範囲: ${before} から ${after} まで`,
		`変更ファイルの一覧（binary は Git がバイナリーと判定したファイル）: ${JSON.stringify(manifest.changed_files)}`,
		`最初に実行する差分確認コマンド: git diff --no-ext-diff --no-textconv --no-renames ${before} ${after} --`,
	].join("\n");
	return `${base}\n\n${roleGuide}\n\n${dynamicContext}`;
}
const findingFields = [
	"severity",
	"file",
	"line",
	"title",
	"evidence",
	"recommendation",
];
export const schema = {
	type: "object",
	additionalProperties: false,
	required: ["findings", "limitations", "file_coverage"],
	properties: {
		limitations: { type: "array", items: { type: "string", minLength: 1 } },
		file_coverage: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["file", "status", "detail"],
				properties: {
					file: { type: "string", minLength: 1 },
					status: { type: "string", enum: ["reviewed", "unreadable"] },
					detail: { type: "string", minLength: 1 },
				},
			},
		},
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: findingFields,
				properties: {
					severity: {
						type: "string",
						enum: ["critical", "high", "medium", "low"],
					},
					file: { type: "string", minLength: 1 },
					line: { type: "integer", minimum: 1 },
					title: { type: "string", minLength: 1 },
					evidence: { type: "string", minLength: 1 },
					recommendation: { type: "string", minLength: 1 },
				},
			},
		},
	},
};

function objectWithKeys(value, keys) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
	);
}
const nonempty = (value) => typeof value === "string" && Boolean(value.trim());
export function validateReview(data) {
	if (
		!objectWithKeys(data, ["findings", "limitations", "file_coverage"]) ||
		!Array.isArray(data.findings) ||
		!Array.isArray(data.limitations) ||
		!Array.isArray(data.file_coverage)
	) {
		throw new Error(
			"レビュー結果の findings、limitations、file_coverage が不正です。",
		);
	}
	if (!data.limitations.every(nonempty))
		throw new Error("レビューの確認できなかった範囲が不正です。");
	for (const item of data.file_coverage) {
		if (
			!objectWithKeys(item, ["file", "status", "detail"]) ||
			!nonempty(item.file) ||
			!nonempty(item.detail) ||
			!["reviewed", "unreadable"].includes(item.status)
		) {
			throw new Error("ファイルごとの確認状況が不正です。");
		}
	}
	for (const item of data.findings) {
		if (
			!objectWithKeys(item, findingFields) ||
			!["critical", "high", "medium", "low"].includes(item.severity) ||
			!Number.isInteger(item.line) ||
			item.line < 1 ||
			!["file", "title", "evidence", "recommendation"].every((key) =>
				nonempty(item[key]),
			)
		) {
			throw new Error("レビューの指摘が不正です。");
		}
	}
}
