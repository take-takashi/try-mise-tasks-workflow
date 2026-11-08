"""ADR の作成、検索、規約の検証。"""

import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[4]
DIRECTORY = ROOT / "docs" / "decisions"
ID_PATTERN = re.compile(r"ADR-(\d{4,})\Z")
FILENAME_PATTERN = re.compile(r"(\d{4,})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md\Z")
REFERENCE_PATTERN = re.compile(r"\[\[(ADR-\d{4,})\]\]")


def output(data):
    print(json.dumps(data, ensure_ascii=False))


def error(message):
    output({"ok": False, "error": message})
    return 1


def run(action, *arguments):
    try:
        return action(*arguments)
    except (OSError, UnicodeError) as exc:
        return error(f"文書を処理できません: {exc}")


def read_document(path):
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if len(lines) < 4 or lines[0] != "---" or lines[2] != "---":
        raise ValueError("先頭に JSON 形式のメタデータが必要です")
    try:
        metadata = json.loads(lines[1])
    except json.JSONDecodeError as exc:
        raise ValueError("メタデータが不正な JSON です") from exc
    if not isinstance(metadata, dict) or set(metadata) != {"id", "title", "type"}:
        raise ValueError("メタデータには id、title、type が必要です")
    if not isinstance(metadata["id"], str) or not ID_PATTERN.fullmatch(metadata["id"]):
        raise ValueError("id は ADR-0001 の形式で指定してください")
    if not isinstance(metadata["title"], str) or not metadata["title"].strip():
        raise ValueError("title は空にできません")
    if metadata["type"] != "adr":
        raise ValueError("type は adr にしてください")
    filename = FILENAME_PATTERN.fullmatch(path.name)
    if not filename or filename.group(1) != metadata["id"][4:]:
        raise ValueError("ファイル名の番号と id が一致しません")
    return metadata, text


def documents():
    return sorted(DIRECTORY.glob("*.md")) if DIRECTORY.exists() else []


def relative(path):
    return path.relative_to(ROOT).as_posix()


def new(kind, title):
    if kind != "adr":
        return error("type は adr のみ対応しています")
    title = title.strip()
    if not title or "\n" in title or "\r" in title:
        return error("タイトルには空でない一行の文字列を指定してください")
    paths = documents()
    numbers = []
    for path in paths:
        match = FILENAME_PATTERN.fullmatch(path.name)
        if not match:
            return error(f"不正なファイル名です: {relative(path)}")
        numbers.append(int(match.group(1)))
    number = max(numbers, default=0) + 1
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    identifier = f"ADR-{number:04d}"
    path = DIRECTORY / f"{number:04d}.md"
    metadata = {"id": identifier, "title": title, "type": kind}
    content = (f"---\n{json.dumps(metadata, ensure_ascii=False)}\n---\n\n"
               f"# {title}\n\n## 背景\n\n## 決定\n\n## 影響\n")
    try:
        with path.open("x", encoding="utf-8", newline="\n") as file:
            file.write(content)
    except FileExistsError:
        return error("同じ番号の文書が作成されました。もう一度実行してください")
    output({"ok": True, "document": {**metadata, "path": relative(path)}})
    return 0


def search(query):
    if not query.strip():
        return error("検索語を指定してください")
    matches = []
    for path in documents():
        try:
            metadata, text = read_document(path)
        except (ValueError, UnicodeError, OSError) as exc:
            return error(f"{relative(path)}: {exc}")
        if query.casefold() in text.casefold():
            matches.append({**metadata, "path": relative(path)})
    output({"ok": True, "documents": matches})
    return 0


def validate():
    issues = []
    found = {}
    references = []
    paths = documents()
    for path in paths:
        try:
            metadata, text = read_document(path)
        except (ValueError, UnicodeError, OSError) as exc:
            issues.append({"path": relative(path), "message": str(exc)})
            continue
        identifier = metadata["id"]
        if identifier in found:
            issues.append({"path": relative(path), "message": f"ID が重複しています: {identifier}"})
        found[identifier] = path
        references.extend((path, reference) for reference in REFERENCE_PATTERN.findall(text))
    for path, reference in references:
        if reference not in found:
            issues.append({"path": relative(path), "message": f"参照先が見つかりません: {reference}"})
    output({"ok": not issues, "checked": len(paths), "errors": issues})
    return 1 if issues else 0
