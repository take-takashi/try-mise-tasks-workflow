"""MDWのレビューを再利用可能なPython関数として実行する。"""

from concurrent.futures import ThreadPoolExecutor
import os
import subprocess
import time
import uuid

from .. import _common


def prepare():
    """対象コミットを固定し、今回の実行で使う出力を初期化する。"""
    _common.initialize_root()
    started = time.perf_counter()
    _common.OUTPUT.mkdir(exist_ok=True)
    for name in ("merged.json", "security.json", "quality.json", "manifest.json", "diff.txt"):
        (_common.OUTPUT / name).unlink(missing_ok=True)

    base_ref = os.environ.get("MDW_REVIEW_BASE", os.environ.get("AWF_REVIEW_BASE", "main"))
    head_ref = os.environ.get("MDW_REVIEW_HEAD", os.environ.get("AWF_REVIEW_HEAD", "HEAD"))
    if not base_ref or not head_ref:
        raise ValueError("MDW_REVIEW_BASE と MDW_REVIEW_HEAD には空でないコミットまたはブランチを指定してください。")
    base = _common.run(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{base_ref}^{{commit}}"], timeout=30
    ).stdout.strip()
    head = _common.run(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{head_ref}^{{commit}}"], timeout=30
    ).stdout.strip()
    merge_base = _common.run(["git", "merge-base", base, head], timeout=30).stdout.strip()
    try:
        diff = subprocess.run(
            ["git", "diff", "--numstat", "-z", "--no-renames", "--no-ext-diff",
             "--no-textconv", merge_base, head, "--"],
            cwd=_common.ROOT,
            capture_output=True,
            timeout=30,
            check=False,
            shell=False,
        )
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
        files.append({
            "path": path,
            "binary": parts[0] == b"-" and parts[1] == b"-",
            "path_encoding_error": path_encoding_error,
        })

    manifest = {
        "run_id": str(uuid.uuid4()),
        "base_ref": base_ref,
        "head_ref": head_ref,
        "base_commit": base,
        "merge_base_commit": merge_base,
        "head_commit": head,
        "changed_files": files,
        "started_monotonic": started,
    }
    _common.write_json(_common.OUTPUT / "manifest.json", manifest)
    return manifest


def _collect(manifest):
    reviews = []
    for role in _common.ROLES:
        item = _common.read_json(_common.OUTPUT / f"{role}.json")
        if not isinstance(item, dict) or item.get("reviewer_id") != role or item.get("target") != manifest:
            raise ValueError(f"{role} の結果が今回のレビューと一致しません。")
        _common.validate_review(item.get("review"))
        reviews.append(item)
    if _common.read_json(_common.OUTPUT / "manifest.json") != manifest:
        raise ValueError("集約前にレビューの対象が変更されました。")

    result = {
        "target": manifest,
        "duration_seconds": round(time.perf_counter() - manifest["started_monotonic"], 3),
        "reviews": reviews,
    }
    _common.write_json(_common.OUTPUT / "merged.json", result)
    return result


def run():
    """レビューを準備、認証確認、並列実行、集約し、結果を返す。"""
    manifest = prepare()
    _common.check()
    with ThreadPoolExecutor(max_workers=len(_common.ROLES)) as executor:
        futures = {
            role: executor.submit(_common.review, role, manifest)
            for role in _common.ROLES
        }
        for future in futures.values():
            future.result()
    result = _collect(manifest)
    target = _common.OUTPUT / "merged.json"
    print(
        f"集約結果を保存しました: {target}（全体: {result['duration_seconds']:.3f}秒）",
        flush=True,
    )
    return result
