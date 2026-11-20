#!/usr/bin/env node
//MISE description="マージ済みの worktree を片付ける"
//USAGE arg "<target>" help="対象の worktree のパス"
import {
	assertMerged,
	getCleanHead,
	origin,
	removeWorktree,
	repository,
	resolveCleanupTarget,
	updateMain,
} from "../_lib/worktree.mts";

export function cleanupWorktree({ target, cwd = origin() }) {
	if (!target) throw new Error("削除する worktree を指定してください。");
	// 親のチェックアウトの場所と、登録済みの worktree を調べる。
	const { root, items } = repository(cwd);
	// 指定されたパスが .worktree/ 内の作業場所であることを確認する。
	const worktree = resolveCleanupTarget({ target, cwd, root, items });
	// 未コミットの変更や、未追跡・無視対象のファイルがないことを確かめ、先端のコミットを取得する。
	const head = getCleanHead(worktree.path);
	// main を fast-forward できる場合は更新し、マージの判定に使うコミットを決める。
	const main = updateMain(root, items);
	// 対象のコミットが Git の履歴またはマージ済みの PR から確認できるかを調べる。
	assertMerged(root, worktree, head, main);
	// 確認後に対象が変わっていなければ、worktree とローカルブランチを削除する。
	return removeWorktree(root, worktree, head);
}

// タスクファイルを実行したときに処理を始める。import では作業場所を変更しない。
if (import.meta.main) {
	try {
		// mise が渡したパスを使って、対象の worktree を片付ける。
		const result = cleanupWorktree({ target: process.env.usage_target });
		// 呼び出し元が使えるように、結果を JSON で返す。
		console.log(JSON.stringify(result));
	} catch (error) {
		// 失敗の理由を標準エラーに出し、終了コードで失敗を伝える。
		console.error(`エラー: ${error.message}`);
		process.exitCode = 1;
	}
}
