#!/usr/bin/env node
//MISE description="MDWのレビュー ワークフローを実行する"
//USAGE flag "--base <ref>" help="比較元のブランチまたはコミット" default="main"
//USAGE flag "--head <ref>" help="レビュー対象のブランチまたはコミット" default="HEAD"
import { cli } from './_lib/cli.mjs';
import { run } from './_lib/review.mjs';

await cli('セキュリティと品質の観点で並列レビューします。',
  () => run({ baseRef: process.env.usage_base, headRef: process.env.usage_head }), { usage: true });
