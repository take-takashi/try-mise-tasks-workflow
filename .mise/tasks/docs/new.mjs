#!/usr/bin/env node
//MISE description="ADR を新規作成する"
//USAGE arg "<type>" help="文書の種別（adr）"
//USAGE arg "<title>" help="文書のタイトル"
import { cli, newDocument } from './_lib/documents.mjs';

cli(newDocument, process.env.usage_type, process.env.usage_title);
