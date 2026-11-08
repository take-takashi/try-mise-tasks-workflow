#!/usr/bin/env node
//MISE description="レビューの設定と認証を確認する"
import { cli } from '../_lib/cli.mjs';
import { check } from '../_lib/common.mjs';

await cli('レビューの設定と認証を確認します。', async () => {
  await check();
});
