#!/usr/bin/env node
//MISE description="レビューするコミットと変更ファイルを固定する"
//USAGE flag "--base <ref>" help="比較元のブランチまたはコミット" default="main"
//USAGE flag "--head <ref>" help="レビュー対象のブランチまたはコミット" default="HEAD"
import { cli, isMainModule } from "../_lib/cli.mts";
import { prepare } from "../_lib/review-steps.mts";

export async function run(options = {}) {
	// レビューするコミットと変更ファイルを固定する。
	const manifest = await prepare(options);
	// 固定した差分の開始と終了のコミットを表示する。
	console.log(
		`レビュー対象のコミットを固定しました: ${manifest.merge_base_commit}..${manifest.head_commit}`,
	);
	return manifest;
}

// タスクファイルを実行したときに run() を呼び出す。import では対象を準備しない。
if (isMainModule(import.meta)) {
	// ヘルプの表示と、失敗時の終了コードの設定を cli() に任せる。
	await cli(
		"レビュー対象を準備します。",
		// mise が渡した --base と --head を使って対象を準備する。
		() =>
			run({ baseRef: process.env.usage_base, headRef: process.env.usage_head }),
		{ usage: true },
	);
}
