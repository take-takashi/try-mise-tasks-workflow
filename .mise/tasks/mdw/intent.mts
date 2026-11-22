#!/usr/bin/env node
//MISE description="現在の会話から intent を更新するための手順を出力する"

import { cli } from "./_lib/cli.mts";
import { buildIntentPrompt } from "./_lib/intent.mts";

export function run() {
	// interview と共有する intent の更新手順を取得して呼び出し元へ返す。
	return buildIntentPrompt();
}

// mise などから実行したときは、現在の会話を持つ AI が使う手順を標準出力へ返す。
// この入口は別の AI を起動せず、intent の読み書きも行わない。
if (import.meta.main) {
	await cli(
		"現在の会話から docs/intent.md を更新する手順を出力します。出力を読んだ AI が、会話の文脈を使って編集してください。",
		() => console.log(run()),
	);
}
