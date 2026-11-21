#!/usr/bin/env node
//MISE description="ADR のメタデータと参照を検証する"
import {
	cli,
	documents,
	findMissingReferences,
	inspectDocuments,
} from "./_lib/documents.mts";

export function validate() {
	// 検証する ADR を列挙する。
	const files = documents();
	// メタデータと ID を検証し、文書間の参照を集める。
	const { issues, found, references } = inspectDocuments(files);
	// 参照先が見つからない場合は、検証エラーに加える。
	const errors = issues.concat(findMissingReferences(references, found));
	return { ok: errors.length === 0, checked: files.length, errors };
}

// タスクファイルを実行したときは、処理の結果を cli() が JSON で出力する。
// 別のワークフローからは、上の関数を import して呼び出せる。
if (import.meta.main) {
	// ADR の検証結果を返す。
	cli(validate);
}
