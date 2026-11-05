#!/usr/bin/env python
#MISE description="AWFで使うレビュアーの設定と認証を確認する"
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common


if __name__ == "__main__":
    try:
        _common.check()
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
