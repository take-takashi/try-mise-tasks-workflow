#!/usr/bin/env node
//MISE description="対話を通じてプロジェクトの intent を作成・更新する"
//USAGE flag "--prompt" help="AI CLI を起動せず、プロンプトだけを出力する"

import { AgentClient } from "./_lib/agent-client.mts";
import { requireInteractiveTerminal } from "./_lib/command.mts";
import { buildPrompt, discoverRoot } from "./_lib/interview.mts";

export async function run({
	cwd = process.env.MISE_ORIGINAL_CWD || process.cwd(),
	promptOnly = false,
	environment = process.env,
} = {}) {
	// 呼び出した場所が属する worktree のルートを特定する。
	const root = await discoverRoot(cwd);
	// 一問ずつ深掘りし、その場で intent を更新するプロンプトを用意する。
	const prompt = buildPrompt();
	// 既存の AI チャットへ渡す場合は、プロンプトだけを出力する。
	if (promptOnly) {
		console.log(prompt);
		return 0;
	}
	// 対話に必要な端末があることを CLI の起動前に確認する。
	requireInteractiveTerminal();
	// 共通の AI クライアントで interview の設定と実行環境を用意する。
	const agent = new AgentClient({
		cwd: root,
		environment,
		workflow: "interview",
	});
	// プロバイダー、モデル、課金方式、エフォートと CLI の場所を確認する。
	const settings = agent.config();
	// 指定した課金方式と CLI の認証状態が一致することを確認する。
	await agent.check();
	// 人が応答できるように端末を引き継ぎ、会話の終了まで待つ。
	return await agent.runInteractive(settings, prompt);
}

// mise が渡した引数を読み取り、対話またはプロンプト出力の入口として実行する。
if (import.meta.main) {
	try {
		process.exitCode = await run({
			promptOnly: process.env.usage_prompt === "true",
		});
	} catch (error) {
		console.error(`エラー: ${error.message}`);
		process.exitCode = 1;
	}
}
