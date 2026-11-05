#!/usr/bin/env python
#MISE description="レビューするコミットと変更ファイルを固定する"
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _common


def main():
    _common.initialize_root()
    started = time.perf_counter()
    _common.OUTPUT.mkdir(exist_ok=True)
    for name in ("merged.json", "security.json", "quality.json", "manifest.json", "diff.txt"):
        (_common.OUTPUT / name).unlink(missing_ok=True)
    base_ref = os.environ.get("AWF_REVIEW_BASE", "main")
    head_ref = os.environ.get("AWF_REVIEW_HEAD", "HEAD")
    if not base_ref or not head_ref:
        raise ValueError("AWF_REVIEW_BASE と AWF_REVIEW_HEAD には空でないコミットまたはブランチを指定してください。")
    base = _common.run(["git", "rev-parse", "--verify", "--end-of-options", f"{base_ref}^{{commit}}"], timeout=30).stdout.strip()
    head = _common.run(["git", "rev-parse", "--verify", "--end-of-options", f"{head_ref}^{{commit}}"], timeout=30).stdout.strip()
    merge_base = _common.run(["git", "merge-base", base, head], timeout=30).stdout.strip()
    try:
        diff = subprocess.run(["git", "diff", "--numstat", "-z", "--no-renames", "--no-ext-diff",
                               "--no-textconv", merge_base, head, "--"], cwd=_common.ROOT,
                              capture_output=True, timeout=30, check=False, shell=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"Gitの差分を確認できません: {type(exc).__name__}") from exc
    if diff.returncode:
        raise ValueError(f"Gitの差分確認が終了コード {diff.returncode} で失敗しました。")
    if not diff.stdout:
        raise ValueError("指定したコミット間にレビュー対象の差分がありません。")
    files = []
    for entry in diff.stdout.split(b"\0"):
        if not entry:
            continue
        parts = entry.split(b"\t", 2)
        if len(parts) != 3 or not parts[2]:
            raise ValueError("Gitの変更ファイル一覧を読み取れません。")
        try:
            path = parts[2].decode("utf-8")
            path_encoding_error = False
        except UnicodeDecodeError:
            path = parts[2].decode("utf-8", errors="backslashreplace")
            path_encoding_error = True
        files.append({"path": path, "binary": parts[0] == b"-" and parts[1] == b"-",
                      "path_encoding_error": path_encoding_error})
    manifest = {"run_id": str(uuid.uuid4()), "base_ref": base_ref, "head_ref": head_ref,
                "base_commit": base, "merge_base_commit": merge_base, "head_commit": head,
                "changed_files": files, "started_monotonic": started}
    _common.write_json(_common.OUTPUT / "manifest.json", manifest)
    print(f"レビュー対象のコミットを固定しました: {merge_base}..{head}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
