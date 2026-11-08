#!/usr/bin/env node
//MISE description="レビューの設定と認証を確認する"
import { cli } from "../_lib/cli.mts";
import { check } from "../_lib/common.mts";

await cli("レビューの設定と認証を確認します。", async () => {
	await check();
});
