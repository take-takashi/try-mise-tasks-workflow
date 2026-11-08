#!/usr/bin/env node
//MISE description="レビューするコミットと変更ファイルを固定する"
//USAGE flag "--base <ref>" help="比較元のブランチまたはコミット" default="main"
//USAGE flag "--head <ref>" help="レビュー対象のブランチまたはコミット" default="HEAD"
import { cli } from '../_lib/cli.mjs';
import { prepare } from '../_lib/review.mjs';

await cli('レビュー対象を準備します。', async () => {
  const manifest = await prepare({ baseRef: process.env.usage_base, headRef: process.env.usage_head });
  console.log('レビュー対象のコミットを固定しました: ' + manifest.merge_base_commit + '..' + manifest.head_commit);
}, { usage: true });
