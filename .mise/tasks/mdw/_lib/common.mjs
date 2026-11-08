import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual, TextDecoder } from 'node:util';

export let root = path.resolve(process.env.MISE_ORIGINAL_CWD || process.cwd());
export let output = path.join(root, '.reviews');
export const roles = {
  security: '認証、認可、入力処理、情報漏えいなどのセキュリティ上の欠陥',
  quality: '正しさ、回帰、例外処理、テスト不足などの品質上の欠陥',
};
const findingFields = ['severity', 'file', 'line', 'title', 'evidence', 'recommendation'];
const schema = {
  type: 'object', additionalProperties: false, required: ['findings', 'limitations', 'file_coverage'],
  properties: {
    limitations: { type: 'array', items: { type: 'string', minLength: 1 } },
    file_coverage: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['file', 'status', 'detail'],
      properties: { file: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['reviewed', 'unreadable'] }, detail: { type: 'string', minLength: 1 } },
    } },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: findingFields,
      properties: {
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        file: { type: 'string', minLength: 1 }, line: { type: 'integer', minimum: 1 },
        title: { type: 'string', minLength: 1 }, evidence: { type: 'string', minLength: 1 },
        recommendation: { type: 'string', minLength: 1 },
      },
    } },
  },
};

export function runCommand(command, { env = process.env, input = '', timeout = 600, cwd = root } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command[0], command.slice(1), { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(new Error(command[0] + ' の実行に失敗しました: ' + error.name)); return; }
    const stdout = [], stderr = [];
    let timedOut = false, finished = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout * 1000);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      reject(new Error(command[0] + ' の実行に失敗しました: ' + error.name));
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (timedOut) { reject(new Error(command[0] + ' の実行がタイムアウトしました。')); return; }
      if (code !== 0) { reject(new Error(command[0] + ' が終了コード ' + (code ?? signal) + ' で失敗しました。CLIの認証、モデル、設定を確認してください。')); return; }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end(input);
  });
}

export async function initializeRoot() {
  const result = await runCommand(['git', 'rev-parse', '--show-toplevel'], { timeout: 30 });
  root = path.resolve(result.stdout.toString('utf8').trim());
  output = path.join(root, '.reviews');
}

export function readJson(file) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file))); }
  catch (error) { throw new Error(path.basename(file) + ' を読み取れません: ' + error.name); }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), '.tmp-' + randomUUID());
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function objectWithKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
export function validateReview(data) {
  if (!objectWithKeys(data, ['findings', 'limitations', 'file_coverage']) ||
      !Array.isArray(data.findings) || !Array.isArray(data.limitations) || !Array.isArray(data.file_coverage)) {
    throw new Error('レビュー結果の findings、limitations、file_coverage が不正です。');
  }
  if (!data.limitations.every(nonempty)) throw new Error('レビューの確認できなかった範囲が不正です。');
  for (const item of data.file_coverage) {
    if (!objectWithKeys(item, ['file', 'status', 'detail']) || !nonempty(item.file) || !nonempty(item.detail) || !['reviewed', 'unreadable'].includes(item.status)) {
      throw new Error('ファイルごとの確認状況が不正です。');
    }
  }
  for (const item of data.findings) {
    if (!objectWithKeys(item, findingFields) || !['critical', 'high', 'medium', 'low'].includes(item.severity) ||
        !Number.isInteger(item.line) || item.line < 1 || !['file', 'title', 'evidence', 'recommendation'].every(key => nonempty(item[key]))) {
      throw new Error('レビューの指摘が不正です。');
    }
  }
}

export function resolveReviewSetting(role, field, fallback, env = process.env) {
  role = role.toUpperCase(); field = field.toUpperCase();
  for (const key of ['MDW_REVIEW_' + role + '_' + field, 'AWF_REVIEW_' + role + '_' + field, 'MDW_REVIEW_' + field, 'MDW_DEFAULT_' + field]) {
    if (nonempty(env[key])) return env[key];
  }
  return fallback;
}
function executableOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.resolve(dir || '.', name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  throw new Error(name + ' CLI が見つかりません。');
}
export function config(role) {
  const provider = resolveReviewSetting(role, 'PROVIDER', 'codex');
  const model = resolveReviewSetting(role, 'MODEL', 'gpt-6.1-sol');
  const effort = resolveReviewSetting(role, 'EFFORT', 'medium');
  const billing = resolveReviewSetting(role, 'BILLING', 'subscription');
  if (!['codex', 'claude'].includes(provider) || !model || !['subscription', 'api'].includes(billing)) throw new Error('MDW_REVIEW_' + role.toUpperCase() + '_* の設定が不正です。');
  if (provider === 'codex' && billing !== 'subscription') throw new Error('CodexのAPI課金はこのPoCでは対応していません。');
  const allowed = provider === 'codex' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
  if (!allowed.includes(effort)) throw new Error('MDW_REVIEW_' + role.toUpperCase() + '_EFFORT は ' + provider + ' に対応する値を指定してください。');
  return { provider, model, effort, billing, executable: executableOnPath(provider) };
}
export function childEnvironment(provider, billing, environment = process.env) {
  const env = { ...environment };
  const apiKey = env.MDW_ANTHROPIC_API_KEY || env.AWF_ANTHROPIC_API_KEY || '';
  for (const key of ['MDW_ANTHROPIC_API_KEY', 'AWF_ANTHROPIC_API_KEY', 'REVIEW_ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_GATEWAY']) delete env[key];
  if (provider === 'claude' && billing === 'api') {
    if (!apiKey) throw new Error('Claude APIには MDW_ANTHROPIC_API_KEY が必要です。');
    env.ANTHROPIC_API_KEY = apiKey;
  }
  return env;
}
export function timeoutSeconds(env = process.env) {
  const raw = env.MDW_REVIEW_TIMEOUT_SECONDS ?? env.AWF_REVIEW_TIMEOUT_SECONDS ?? '600';
  if (!/^\s*\+?\d+\s*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new Error('MDW_REVIEW_TIMEOUT_SECONDS は正の整数を指定してください。');
  return Number(raw);
}
export async function check() {
  timeoutSeconds();
  for (const role of Object.keys(roles)) {
    const { provider, billing, executable } = config(role);
    const env = childEnvironment(provider, billing);
    if (provider === 'codex') {
      const result = await runCommand([executable, 'login', 'status'], { env, timeout: 30 });
      if (!(result.stdout.toString() + result.stderr.toString()).includes('Logged in using ChatGPT')) throw new Error('CodexのChatGPT認証を確認できません。');
    } else {
      const result = await runCommand([executable, 'auth', 'status'], { env, timeout: 30 });
      let status;
      try { status = JSON.parse(result.stdout.toString('utf8')); } catch { throw new Error('Claudeの認証状態を読み取れません。'); }
      if (status?.authMethod !== (billing === 'api' ? 'api_key' : 'claude.ai')) throw new Error('Claudeの認証方式が指定した ' + billing + ' と一致しません。');
    }
    console.log(role + ': ' + provider + ' の設定と認証を確認しました。');
  }
}

export async function review(role, manifest) {
  const started = performance.now();
  const { provider, model, effort, billing, executable } = config(role);
  const env = childEnvironment(provider, billing);
  const before = manifest.merge_base_commit, after = manifest.head_commit;
  const prompt = 'コミット ' + before + ' から ' + after + ' までの変更を、' + roles[role] + 'の観点でレビューしてください。\n' +
    '変更ファイルの一覧（binaryはGitがバイナリーと判定したファイル）: ' + JSON.stringify(manifest.changed_files) + '\n' +
    'まず git diff --no-ext-diff --no-textconv --no-renames ' + before + ' ' + after + ' -- でコミット間の差分を確認し、' +
    '必要な場合は git show <コミットID>:<パス> を使って変更前後の内容、周辺コードやテストを確認してください。' +
    '作業ツリーやインデックスの未コミット変更をレビュー対象に含めないでください。' +
    '一覧のすべてのファイルについて、file_coverageにfile、確認できたかを示すstatus（reviewedまたはunreadable）、確認方法または確認できなかった理由を示すdetailを記録してください。' +
    'Gitがバイナリーと扱う場合は差分だけで判断せず、可能ならコミット内の内容を取得して確認してください。' +
    'テキストの文字コードが異なる場合も可能な範囲で確認してください。' +
    '読み取れないファイル、ツールの権限や出力制限などで確認できなかった範囲はlimitationsに記載し、確認できなかったものを確認済みとして扱わないでください。' +
    '確認できなかった範囲がなければlimitationsは空配列としてください。変更に起因する具体的な問題だけを報告し、該当しなければfindingsを空配列にしてください。ファイルを変更せず、日本語で出力してください。';
  const timeout = timeoutSeconds();
  let data;
  if (provider === 'codex') {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-review-'));
    try {
      const schemaFile = path.join(temporary, 'schema.json'), resultFile = path.join(temporary, 'response.json');
      fs.writeFileSync(schemaFile, JSON.stringify(schema), 'utf8');
      await runCommand([executable, 'exec', '--ignore-user-config', '-c', 'model_provider="openai"', '-c', 'model_reasoning_effort=' + JSON.stringify(effort), '--sandbox', 'read-only', '--ephemeral', '--model', model, '--output-schema', schemaFile, '-o', resultFile, '-'], { env, input: prompt, timeout });
      data = readJson(resultFile);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  } else {
    const result = await runCommand([executable, '-p', '--model', model, '--effort', effort, '--tools', 'Read,Grep,Glob,Bash', '--permission-mode', 'plan', '--strict-mcp-config', '--no-chrome', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(schema)], { env, input: prompt, timeout });
    let envelope;
    try { envelope = JSON.parse(result.stdout.toString('utf8')); } catch { throw new Error('Claudeの出力が不正なJSONです。'); }
    if (!envelope || envelope.is_error || !('structured_output' in envelope)) throw new Error('Claudeの構造化出力がありません。');
    data = envelope.structured_output;
    if (envelope.permission_denials?.length) { validateReview(data); data.limitations.push('Claudeのツール使用が' + envelope.permission_denials.length + '件拒否されました。'); }
  }
  validateReview(data);
  const expected = new Set(manifest.changed_files.map(item => item.path));
  const coverage = new Map(data.file_coverage.map(item => [item.file, item]));
  if (coverage.size !== data.file_coverage.length) data.limitations.push('同じファイルの確認状況が重複して報告されました。');
  for (const name of [...expected].sort()) if (!coverage.has(name)) data.limitations.push(name + ': エージェントが確認状況を報告しませんでした。');
  for (const name of [...coverage.keys()].sort()) if (!expected.has(name)) data.limitations.push(name + ': 報告されたファイルは変更ファイル一覧にありません。');
  for (const item of manifest.changed_files) {
    if (coverage.get(item.path)?.status === 'unreadable') data.limitations.push(item.path + ': 内容を確認できませんでした。');
    if (item.path_encoding_error) data.limitations.push(item.path + ': ファイル名をUTF-8で読み取れませんでした。');
    if (item.binary) data.limitations.push(item.path + ': Gitがバイナリーと判定しました。確認状況はモデルの申告です。');
  }
  if (!isDeepStrictEqual(readJson(path.join(output, 'manifest.json')), manifest)) throw new Error('レビューの実行中に対象が変更されました。');
  const duration = Math.round((performance.now() - started)) / 1000;
  const result = { reviewer_id: role, provider, model, effort, billing, duration_seconds: duration, target: manifest, review: data };
  writeJson(path.join(output, role + '.json'), result);
  console.log(role + ': ' + data.findings.length + ' 件の指摘、' + data.limitations.length + ' 件の制限を保存しました（' + duration.toFixed(3) + '秒）。');
  return result;
}
