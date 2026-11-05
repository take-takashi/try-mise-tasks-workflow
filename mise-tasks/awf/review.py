#!/usr/bin/env python
#MISE description="各観点のレビューを集約する"
#MISE depends=["awf:review:security", "awf:review:quality"]
import sys
from pathlib import Path
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common


def main():
    _common.initialize_root()
    manifest = _common.read_json(_common.OUTPUT / "manifest.json")
    reviews = []
    for role in _common.ROLES:
        item = _common.read_json(_common.OUTPUT / f"{role}.json")
        if not isinstance(item, dict) or item.get("reviewer_id") != role or item.get("target") != manifest:
            raise ValueError(f"{role} の結果が今回のレビューと一致しません。")
        _common.validate_review(item.get("review"))
        reviews.append(item)
    if _common.read_json(_common.OUTPUT / "manifest.json") != manifest:
        raise ValueError("集約前にレビューの対象が変更されました。")
    target = _common.OUTPUT / "merged.json"
    duration = round(time.perf_counter() - manifest["started_monotonic"], 3)
    _common.write_json(target, {"target": manifest, "duration_seconds": duration, "reviews": reviews})
    print(f"集約結果を保存しました: {target}（全体: {duration:.3f}秒）", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
