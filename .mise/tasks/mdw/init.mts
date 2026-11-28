#!/usr/bin/env node
//MISE description="MDW の設定ファイルを配置し、利用環境の前提を確認する"
//USAGE flag "--force" help="MDW 管理ファイル（.mise/conf.d/mdw.toml・.mdw/.gitignore）を最新版で上書きする"
//USAGE flag "--dry-run" help="ファイルを作成・変更せず計画と診断結果だけを表示する"

import { cli, isMainModule } from "./_lib/cli.mts";
import {
	buildNextSteps,
	diagnoseEnvironment,
	planAndApplyInitFiles,
	resolveGitRoot,
} from "./_lib/init.mts";

export async function run({
	force = false,
	dryRun = false,
	cwd = process.env.MISE_ORIGINAL_CWD || process.cwd(),
	env = process.env,
	nodeVersion = process.versions.node,
	platform = process.platform,
} = {}) {
	// 実行場所が属する Git worktree のルートを特定する（git 不在や Git 管理外はエラー）。
	const root = await resolveGitRoot(cwd, env, platform);
	// 設定ファイル（.mise/conf.d/mdw.toml・.mdw/.gitignore・.mdw/models.env）を計画または配置する。
	const files = planAndApplyInitFiles(root, { force, dryRun });
	// Node.js・Git・gh・AI CLI・タスク実行権限・mise.toml 重複を診断する。
	const diagnostics = diagnoseEnvironment(root, { env, nodeVersion, platform });
	// 状態に応じた次の手順をまとめる。
	const next_steps = buildNextSteps(files, diagnostics);
	return {
		root,
		dry_run: dryRun,
		force,
		files,
		diagnostics,
		next_steps,
	};
}

// タスクファイルを直接実行したときに、mise が渡した引数で run() を呼び出す。
if (isMainModule(import.meta)) {
	await cli(
		"MDW の設定ファイルを配置し、利用環境の前提を確認します。",
		async () => {
			const result = await run({
				force: process.env.usage_force === "true",
				dryRun: process.env.usage_dry_run === "true",
			});
			console.log(JSON.stringify(result, null, 2));
		},
		{ usage: ["usage_force", "usage_dry_run"] },
	);
}
