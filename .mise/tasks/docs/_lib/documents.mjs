import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const directory = path.join(root, 'docs', 'decisions');
const idPattern = /^ADR-(\d{4,})$/;
const filenamePattern = /^(\d{4,})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$/;
const referencesPattern = /\[\[(ADR-\d{4,})\]\]/g;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Python版と同じUnicode 16.0のケースフォールディングを使う。
const casefoldMapping = JSON.parse(fs.readFileSync(new URL('./casefold.json', import.meta.url), 'utf8')).mapping;
const relative = file => path.relative(root, file).split(path.sep).join('/');
const error = message => ({ ok: false, error: message });

function documents() {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.md')).sort().map(name => path.join(directory, name));
}

function readDocument(file) {
  const text = decoder.decode(fs.readFileSync(file));
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length < 4 || lines[0] !== '---' || lines[2] !== '---') {
    throw new Error('先頭に JSON 形式のメタデータが必要です');
  }
  let metadata;
  try { metadata = JSON.parse(lines[1]); } catch { throw new Error('メタデータが不正な JSON です'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      Object.keys(metadata).sort().join(',') !== 'id,title,type') {
    throw new Error('メタデータには id、title、type が必要です');
  }
  if (typeof metadata.id !== 'string' || !idPattern.test(metadata.id)) throw new Error('id は ADR-0001 の形式で指定してください');
  if (typeof metadata.title !== 'string' || !metadata.title.trim()) throw new Error('title は空にできません');
  if (metadata.type !== 'adr') throw new Error('type は adr にしてください');
  const match = filenamePattern.exec(path.basename(file));
  if (!match || match[1] !== metadata.id.slice(4)) throw new Error('ファイル名の番号と id が一致しません');
  return { metadata, text };
}

export function newDocument(kind, title) {
  if (kind !== 'adr') return error('type は adr のみ対応しています');
  title = title.trim();
  if (!title || /[\r\n]/.test(title)) return error('タイトルには空でない一行の文字列を指定してください');
  let number = 0n;
  for (const file of documents()) {
    const match = filenamePattern.exec(path.basename(file));
    if (!match) return error('不正なファイル名です: ' + relative(file));
    const candidate = BigInt(match[1]);
    if (candidate > number) number = candidate;
  }
  const digits = String(number + 1n).padStart(4, '0');
  const metadata = { id: 'ADR-' + digits, title, type: kind };
  const file = path.join(directory, digits + '.md');
  const content = '---\n' + JSON.stringify(metadata) + '\n---\n\n# ' + title + '\n\n## 背景\n\n## 決定\n\n## 影響\n';
  fs.mkdirSync(directory, { recursive: true });
  try { fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' }); }
  catch (exc) { if (exc.code === 'EEXIST') return error('同じ番号の文書が作成されました。もう一度実行してください'); throw exc; }
  return { ok: true, document: { ...metadata, path: relative(file) } };
}

function fold(text) { return Array.from(text, character => casefoldMapping[character] ?? character).join(''); }

export function search(query) {
  if (!query.trim()) return error('検索語を指定してください');
  const matches = [];
  for (const file of documents()) {
    let document;
    try { document = readDocument(file); }
    catch (exc) { return error(relative(file) + ': ' + exc.message); }
    if (fold(document.text).includes(fold(query))) matches.push({ ...document.metadata, path: relative(file) });
  }
  return { ok: true, documents: matches };
}

export function validate() {
  const issues = [], found = new Map(), references = [];
  const files = documents();
  for (const file of files) {
    let document;
    try { document = readDocument(file); }
    catch (exc) { issues.push({ path: relative(file), message: exc.message }); continue; }
    const id = document.metadata.id;
    if (found.has(id)) issues.push({ path: relative(file), message: 'ID が重複しています: ' + id });
    found.set(id, file);
    for (const match of document.text.matchAll(referencesPattern)) references.push([file, match[1]]);
  }
  for (const [file, reference] of references) {
    if (!found.has(reference)) issues.push({ path: relative(file), message: '参照先が見つかりません: ' + reference });
  }
  return { ok: issues.length === 0, checked: files.length, errors: issues };
}

export function cli(action, ...args) {
  try {
    const result = action(...args);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (exc) {
    console.log(JSON.stringify(error('文書を処理できません: ' + exc.message)));
    process.exitCode = 1;
  }
}
