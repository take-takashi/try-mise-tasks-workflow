#!/usr/bin/env python
#MISE description="レビューするコミットと変更ファイルを固定する"
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from awf._lib.review import prepare


def main():
    manifest = prepare()
    print(
        "レビュー対象のコミットを固定しました: "
        f"{manifest['merge_base_commit']}..{manifest['head_commit']}",
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
