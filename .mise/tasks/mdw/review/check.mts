#!/usr/bin/env node
import { check } from "../_lib/agent-client.mts";
//MISE description="レビューの設定と認証を確認する"
import { cli } from "../_lib/cli.mts";

// タスクファイルを実行したときに AI CLI の設定と認証を確認する。
if (import.meta.main) {
	// ヘルプの表示と、失敗時の終了コードの設定を cli() に任せる。
	await cli("レビューの設定と認証を確認します。", check);
}
