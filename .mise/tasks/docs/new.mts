#!/usr/bin/env node
//MISE description="ADR を新規作成する"
//USAGE arg "<type>" help="文書の種別（adr）"
//USAGE arg "<title>" help="文書のタイトル"
import {
	cli,
	documents,
	error,
	nextDocumentNumber,
	saveDocument,
} from "./_lib/documents.mts";

export function newDocument(kind, title) {
	// 文書の種別とタイトルを確認する。
	if (kind !== "adr") return error("type は adr のみ対応しています");
	title = title.trim();
	if (!title || /[\r\n]/.test(title))
		return error("タイトルには空でない一行の文字列を指定してください");

	// 既存の ADR を列挙する。
	const files = documents();
	// 次に使う番号を決める。
	const next = nextDocumentNumber(files);
	if (!next.ok) return next;
	// 決めた番号で ADR のひな型を保存する。
	return saveDocument(kind, title, next.digits);
}

// タスクファイルを実行したときは、処理の結果を cli() が JSON で出力する。
// 別のワークフローからは、上の関数を import して呼び出せる。
if (import.meta.main) {
	// mise が渡した種別とタイトルで ADR を作成する。
	cli(newDocument, process.env.usage_type, process.env.usage_title);
}
