#!/usr/bin/env python
#MISE description="品質の観点でコミットをレビューする"
#MISE depends=["mdw:review:check"]
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mdw._lib import _common


if __name__ == "__main__":
    try:
        _common.initialize_root()
        _common.review("quality", _common.read_json(_common.OUTPUT / "manifest.json"))
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
