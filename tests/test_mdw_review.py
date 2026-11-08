"""MDWレビューの統合と旧設定からの移行を検証する。"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT / ".mise" / "tasks"))
from mdw._lib import _common


class ReviewConfigurationTest(unittest.TestCase):
    def test_timeout_and_api_key_prefer_mdw_and_support_awf(self):
        with patch.dict(os.environ, {
            "AWF_REVIEW_TIMEOUT_SECONDS": "31",
            "AWF_ANTHROPIC_API_KEY": "old-key",
        }, clear=True):
            self.assertEqual(_common.timeout_seconds(), 31)
            self.assertEqual(_common.child_environment("claude", "api")["ANTHROPIC_API_KEY"], "old-key")
            os.environ["MDW_REVIEW_TIMEOUT_SECONDS"] = "12"
            os.environ["MDW_ANTHROPIC_API_KEY"] = "new-key"
            self.assertEqual(_common.timeout_seconds(), 12)
            child = _common.child_environment("claude", "api")
            self.assertEqual(child["ANTHROPIC_API_KEY"], "new-key")
            self.assertNotIn("MDW_ANTHROPIC_API_KEY", child)
            self.assertNotIn("AWF_ANTHROPIC_API_KEY", child)


@unittest.skipUnless(os.name == "posix", "File Taskの実行はPOSIX環境で確認する")
class ReviewWorkflowTest(unittest.TestCase):
    def test_copied_workflow_runs_with_fake_provider(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tasks = root / ".mise" / "tasks"
            shutil.copytree(PROJECT / ".mise" / "tasks" / "mdw", tasks / "mdw",
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
            sample = root / "sample.txt"
            for value in ("before", "after"):
                sample.write_text(value, encoding="utf-8")
                subprocess.run(["git", "add", "sample.txt"], cwd=root, check=True)
                subprocess.run(["git", "-c", "user.name=MDW Test", "-c", "user.email=mdw@example.invalid",
                                "commit", "-q", "-m", value], cwd=root, check=True)
                if value == "before":
                    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, check=True,
                                          capture_output=True, text=True).stdout.strip()

            binary = root / "bin"
            binary.mkdir()
            codex = binary / "codex"
            codex.write_text(
                f"#!{sys.executable}\n"
                "import json, pathlib, sys\n"
                "if sys.argv[1:3] == ['login', 'status']:\n"
                "    print('Logged in using ChatGPT')\n"
                "else:\n"
                "    result = {'findings': [], 'limitations': [], 'file_coverage': "
                "[{'file': 'sample.txt', 'status': 'reviewed', 'detail': 'fake'}]}\n"
                "    pathlib.Path(sys.argv[sys.argv.index('-o') + 1]).write_text(json.dumps(result))\n",
                encoding="utf-8",
            )
            codex.chmod(0o755)
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("MDW_", "AWF_")) and key != "MISE_ORIGINAL_CWD"}
            env.update({"PATH": f"{binary}{os.pathsep}{env['PATH']}", "MDW_REVIEW_BASE": base,
                        "AWF_REVIEW_BASE": "invalid-legacy-ref", "MDW_REVIEW_HEAD": "HEAD"})
            result = subprocess.run([sys.executable, str(tasks / "mdw" / "review.py")],
                                    cwd=root, env=env, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 0, result.stderr)
            merged = json.loads((root / ".reviews" / "merged.json").read_text(encoding="utf-8"))
            self.assertEqual(merged["target"]["base_commit"], base)
            self.assertEqual({review["reviewer_id"] for review in merged["reviews"]}, {"security", "quality"})
            del env["MDW_REVIEW_BASE"]
            env["AWF_REVIEW_BASE"] = base
            result = subprocess.run([sys.executable, str(tasks / "mdw" / "review.py")],
                                    cwd=root, env=env, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 0, result.stderr)
            merged = json.loads((root / ".reviews" / "merged.json").read_text(encoding="utf-8"))
            self.assertEqual(merged["target"]["base_commit"], base)


if __name__ == "__main__":
    unittest.main()
