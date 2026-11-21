#!/usr/bin/env node
//MISE description="集約済みのレビューの指摘を評価する"
import { cli } from "../_lib/cli.mts";
import {
	judgeFindings,
	loadReviewInput,
	saveJudgment,
} from "../_lib/judge.mts";

export async function run() {
	// 固定した対象と集約済みのレビューが一致することを確認する。
	const input = await loadReviewInput();
	// 各指摘の根拠を調べ、採用、棄却、根拠不足、重複のいずれかを判定する。
	const evaluation = await judgeFindings(input);
	// 評価結果を .reviews/judged.json に保存する。
	const file = saveJudgment(input, evaluation);
	// 保存先と評価した指摘の件数を表示する。
	console.log(
		`評価結果を保存しました: ${file}（${evaluation.decisions.length}件）`,
	);
	return evaluation;
}

// タスクファイルを直接実行したときに run() を呼び出す。
if (import.meta.main) {
	// ヘルプの表示と、失敗時の終了コードの設定を cli() に任せる。
	await cli("集約済みのレビューの指摘を評価します。", run);
}
