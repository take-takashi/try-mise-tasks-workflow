#!/usr/bin/env python
#MISE description="各観点のレビューを集約する"
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from awf._lib.review import run


def main():
    argparse.ArgumentParser(description="セキュリティと品質の観点で並列レビューします。").parse_args()
    run()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        sys.exit(1)
