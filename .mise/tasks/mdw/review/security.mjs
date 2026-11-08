#!/usr/bin/env node
//MISE description="セキュリティの観点でコミットをレビューする"
//USAGE flag "--base <ref>" help="比較元のブランチまたはコミット" default="main"
//USAGE flag "--head <ref>" help="レビュー対象のブランチまたはコミット" default="HEAD"
import { cli } from '../_lib/cli.mjs';
import { runRole } from '../_lib/review.mjs';

await cli('セキュリティの観点でレビューします。',
  () => runRole('security', { baseRef: process.env.usage_base, headRef: process.env.usage_head }), { usage: true });
