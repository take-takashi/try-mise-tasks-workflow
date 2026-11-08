#!/usr/bin/env python
#MISE description="レビューの設定と認証を確認する"
#MISE depends=["awf:review:prepare"]
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _common


if __name__ == "__main__":
    try:
        _common.initialize_root()
        _common.check()
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
