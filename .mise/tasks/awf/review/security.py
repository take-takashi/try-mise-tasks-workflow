#!/usr/bin/env python
#MISE description="セキュリティの観点でコミットをレビューする"
#MISE depends=["awf:review:check"]
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import _common


if __name__ == "__main__":
    try:
        _common.initialize_root()
        _common.review("security", _common.read_json(_common.OUTPUT / "manifest.json"))
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
