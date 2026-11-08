import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import * as common from './common.mjs';

const monotonicSeconds = () => Number(process.hrtime.bigint()) / 1e9;

function decodePath(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try { return { path: decoder.decode(bytes), path_encoding_error: false }; }
  catch {
    let result = '';
    for (let i = 0; i < bytes.length;) {
      const first = bytes[i];
      const size = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
      if (size && i + size <= bytes.length) {
        try { result += decoder.decode(bytes.subarray(i, i + size)); i += size; continue; } catch {}
      }
      result += '\\x' + first.toString(16).padStart(2, '0');
      i++;
    }
    return { path: result, path_encoding_error: true };
  }
}

export async function prepare(options = {}) {
  const baseRef = options.baseRef ?? 'main';
  const headRef = options.headRef ?? 'HEAD';
  if (typeof baseRef !== 'string' || !baseRef.trim() || typeof headRef !== 'string' || !headRef.trim()) {
    throw new Error('baseRef と headRef には空でないコミットまたはブランチを指定してください。');
  }
  await common.initializeRoot();
  const started = monotonicSeconds();
  fs.mkdirSync(common.output, { recursive: true });
  for (const name of ['merged.json', 'security.json', 'quality.json', 'manifest.json', 'diff.txt']) {
    fs.rmSync(path.join(common.output, name), { force: true });
  }
  const rev = async ref => (await common.runCommand(['git', 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], { timeout: 30 })).stdout.toString('utf8').trim();
  const base = await rev(baseRef), head = await rev(headRef);
  const mergeBase = (await common.runCommand(['git', 'merge-base', base, head], { timeout: 30 })).stdout.toString('utf8').trim();
  const diff = (await common.runCommand(['git', 'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', mergeBase, head, '--'], { timeout: 30 })).stdout;
  if (!diff.length) throw new Error('指定したコミット間にレビュー対象の差分がありません。');
  const files = [];
  for (let position = 0; position < diff.length;) {
    const end = diff.indexOf(0, position);
    if (end < 0) throw new Error('Gitの変更ファイル一覧を読み取れません。');
    const entry = diff.subarray(position, end); position = end + 1;
    if (!entry.length) continue;
    const first = entry.indexOf(9), second = entry.indexOf(9, first + 1);
    if (first < 0 || second < 0 || second === entry.length - 1) throw new Error('Gitの変更ファイル一覧を読み取れません。');
    const decoded = decodePath(entry.subarray(second + 1));
    files.push({ path: decoded.path, binary: entry.subarray(0, first).toString() === '-' && entry.subarray(first + 1, second).toString() === '-', path_encoding_error: decoded.path_encoding_error });
  }
  const manifest = { run_id: randomUUID(), base_ref: baseRef, head_ref: headRef, base_commit: base,
    merge_base_commit: mergeBase, head_commit: head, changed_files: files, started_monotonic: started };
  common.writeJson(path.join(common.output, 'manifest.json'), manifest);
  return manifest;
}

export function collect(manifest) {
  const reviews = [];
  for (const role of Object.keys(common.roles)) {
    const item = common.readJson(path.join(common.output, role + '.json'));
    if (!item || item.reviewer_id !== role || !isDeepStrictEqual(item.target, manifest)) throw new Error(role + ' の結果が今回のレビューと一致しません。');
    common.validateReview(item.review);
    reviews.push(item);
  }
  if (!isDeepStrictEqual(common.readJson(path.join(common.output, 'manifest.json')), manifest)) throw new Error('集約前にレビューの対象が変更されました。');
  const result = { target: manifest, duration_seconds: Math.round((monotonicSeconds() - manifest.started_monotonic) * 1000) / 1000, reviews };
  common.writeJson(path.join(common.output, 'merged.json'), result);
  return result;
}

export async function run(options = {}) {
  const manifest = await prepare(options);
  await common.check();
  const outcomes = await Promise.allSettled(Object.keys(common.roles).map(role => common.review(role, manifest)));
  const failure = outcomes.find(outcome => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  const result = collect(manifest);
  console.log('集約結果を保存しました: ' + path.join(common.output, 'merged.json') + '（全体: ' + result.duration_seconds.toFixed(3) + '秒）');
  return result;
}

export async function runRole(role, options = {}) {
  if (!Object.hasOwn(common.roles, role)) throw new Error('不明なレビューの観点です: ' + role);
  const manifest = await prepare(options);
  await common.check();
  return common.review(role, manifest);
}
