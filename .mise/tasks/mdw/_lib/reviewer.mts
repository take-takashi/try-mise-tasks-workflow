import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { AgentClient } from "./agent-client.mts";
import { roles, schema, validateReview } from "./review-data.mts";

export async function review(
	role,
	manifest,
	workspace,
	agent = new AgentClient({ cwd: workspace.root }),
) {
	const started = performance.now();
	const settings = agent.config(role);
	const { provider, model, effort, billing } = settings;
	const before = manifest.merge_base_commit,
		after = manifest.head_commit;
	const prompt =
		"コミット " +
		before +
		" から " +
		after +
		" までの変更を、" +
		roles[role] +
		"の観点でレビューしてください。\n" +
		"変更ファイルの一覧（binaryはGitがバイナリーと判定したファイル）: " +
		JSON.stringify(manifest.changed_files) +
		"\n" +
		"まず git diff --no-ext-diff --no-textconv --no-renames " +
		before +
		" " +
		after +
		" -- でコミット間の差分を確認し、" +
		"必要な場合は git show <コミットID>:<パス> を使って変更前後の内容、周辺コードやテストを確認してください。" +
		"作業ツリーやインデックスの未コミット変更をレビュー対象に含めないでください。" +
		"一覧のすべてのファイルについて、file_coverageにfile、確認できたかを示すstatus（reviewedまたはunreadable）、確認方法または確認できなかった理由を示すdetailを記録してください。" +
		"Gitがバイナリーと扱う場合は差分だけで判断せず、可能ならコミット内の内容を取得して確認してください。" +
		"テキストの文字コードが異なる場合も可能な範囲で確認してください。" +
		"読み取れないファイル、ツールの権限や出力制限などで確認できなかった範囲はlimitationsに記載し、確認できなかったものを確認済みとして扱わないでください。" +
		"確認できなかった範囲がなければlimitationsは空配列としてください。変更に起因する具体的な問題だけを報告し、該当しなければfindingsを空配列にしてください。ファイルを変更せず、日本語で出力してください。";
	const { data, permissionDenials } = await agent.runStructured(
		settings,
		prompt,
		schema,
	);
	validateReview(data);
	if (permissionDenials) {
		data.limitations.push(
			`Claudeのツール使用が${permissionDenials}件拒否されました。`,
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
		model,
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
