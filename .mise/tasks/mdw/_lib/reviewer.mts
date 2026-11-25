import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { AgentClient } from "./agent-client.mts";
import { buildReviewPrompt, schema, validateReview } from "./review-data.mts";

export async function review(
	role,
	manifest,
	workspace,
	agent = new AgentClient({ cwd: workspace.root }),
) {
	const started = performance.now();
	const settings = agent.config(role);
	const { provider, model, effort, billing } = settings;
	const prompt = buildReviewPrompt(role, manifest);
	const { data, permissionDenials } = await agent.runStructured(
		settings,
		prompt,
		schema,
	);
	validateReview(data);
	if (permissionDenials) {
		const label = provider === "claude" ? "Claude" : provider;
		data.limitations.push(
			`${label}のツール使用が${permissionDenials}件拒否されました。`,
		);
	}
	const expected = new Set(manifest.changed_files.map((item) => item.path));
	const coverage = new Map(data.file_coverage.map((item) => [item.file, item]));
	if (coverage.size !== data.file_coverage.length)
		data.limitations.push("同じファイルの確認状況が重複して報告されました。");
	for (const name of [...expected].sort())
		if (!coverage.has(name))
			data.limitations.push(
				name + ": エージェントが確認状況を報告しませんでした。",
			);
	for (const name of [...coverage.keys()].sort())
		if (!expected.has(name))
			data.limitations.push(
				name + ": 報告されたファイルは変更ファイル一覧にありません。",
			);
	for (const item of manifest.changed_files) {
		if (coverage.get(item.path)?.status === "unreadable")
			data.limitations.push(item.path + ": 内容を確認できませんでした。");
		if (item.path_encoding_error)
			data.limitations.push(
				item.path + ": ファイル名をUTF-8で読み取れませんでした。",
			);
		if (item.binary)
			data.limitations.push(
				item.path +
					": Gitがバイナリーと判定しました。確認状況はモデルの申告です。",
			);
	}
	if (!isDeepStrictEqual(workspace.read("manifest.json"), manifest))
		throw new Error("レビューの実行中に対象が変更されました。");
	const duration = Math.round(performance.now() - started) / 1000;
	const result = {
		reviewer_id: role,
		provider,
		model: model ?? null,
		effort,
		billing,
		duration_seconds: duration,
		target: manifest,
		review: data,
	};
	workspace.write(role + ".json", result);
	console.log(
		role +
			": " +
			data.findings.length +
			" 件の指摘、" +
			data.limitations.length +
			" 件の制限を保存しました（" +
			duration.toFixed(3) +
			"秒）。",
	);
	return result;
}
