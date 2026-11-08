#!/usr/bin/env node
//MISE description="ADR の本文とメタデータを検索する"
//USAGE arg "<query>" help="本文またはメタデータに含まれる検索語"
import { cli, search } from './_lib/documents.mjs';

cli(search, process.env.usage_query);
