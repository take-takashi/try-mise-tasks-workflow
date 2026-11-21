#!/usr/bin/env node
//MISE description="作業用ブランチと worktree を作成する"
//USAGE arg "[task]" help="作業内容"
//USAGE flag "--branch <branch>" help="AI が決めたブランチ名"
import {
	addWorktree,
	origin,
	repository,
	resolveBranchName,
	uniqueBranch,
	updateMain,
	validateBranchInput,
} from "../_lib/worktree.mts";

export async function createWorktree({ branch, task, cwd = origin() }) {
	// ブランチ名と作業内容のどちらか一方が指定されたことを確認する。
	validateBranchInput({ branch, task });
	// 親のチェックアウトの場所と、登録済みの worktree を調べる。
	const { root, items } = repository(cwd);
	// 指定されたブランチ名を確認するか、作業内容から AI に名前を生成させる。
	const requested = await resolveBranchName({ branch, task }, root);
	// main を fast-forward できる場合は更新し、作業の基点を決める。
	const { base, remote } = updateMain(root, items);
	// 既存のブランチや作業場所と重複しない名前とパスを選ぶ。
	const destination = uniqueBranch(root, requested, remote);
	// 選んだブランチと worktree を基点のコミットから作成する。
	return addWorktree(root, destination, base);
}

// タスクファイルを実行したときに処理を始める。import では作業場所を変更しない。
if (import.meta.main) {
	try {
		// mise が渡した作業内容またはブランチ名で worktree を作成する。
		const result = await createWorktree({
			task: process.env.usage_task,
			branch: process.env.usage_branch,
		});
		// 呼び出し元が使えるように、結果を JSON で返す。
		console.log(JSON.stringify(result));
	} catch (error) {
		// 失敗の理由を標準エラーに出し、終了コードで失敗を伝える。
		console.error(`エラー: ${error.message}`);
		process.exitCode = 1;
	}
}
