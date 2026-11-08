#!/usr/bin/env python3
#MISE description="MDWのレビュー ワークフローを実行する"
import argparse
import sys
from pathlib import Path

TASKS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TASKS_ROOT))
from mdw._lib.workflows.review import run


if __name__ == "__main__":
    try:
        argparse.ArgumentParser(description="MDWのレビュー ワークフローを実行します。").parse_args()
        run()
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
