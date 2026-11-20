#!/usr/bin/env node
//MISE description="ADR の本文とメタデータを検索する"
//USAGE arg "<query>" help="本文またはメタデータに含まれる検索語"
import {
	cli,
	documents,
	error,
	findMatchingDocuments,
	fold,
} from "./_lib/documents.mts";

export function search(query) {
	// 空の検索語を拒否する。
	if (!query.trim()) return error("検索語を指定してください");
	// 検索対象の ADR を列挙する。
	const files = documents();
	// 大文字と小文字を区別しない検索に使う形へ変換する。
	const foldedQuery = fold(query);
	// 検索語を含む ADR を探す。
	return findMatchingDocuments(files, foldedQuery);
}

// タスクファイルを実行したときは、処理の結果を cli() が JSON で出力する。
// 別のワークフローからは、上の関数を import して呼び出せる。
if (import.meta.main) {
	// mise が渡した検索語で ADR を検索する。
	cli(search, process.env.usage_query);
}
