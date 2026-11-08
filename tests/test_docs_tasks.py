"""コピーした Docs タスクを mise から実行する統合テスト。"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.name == "posix", "File Task の実行は POSIX 環境で確認する")
class DocsTasksTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        project = Path(__file__).resolve().parent.parent
        shutil.copytree(project / ".mise" / "tasks" / "docs", self.root / ".mise" / "tasks" / "docs",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        self.env = {**os.environ, "MISE_YES": "1"}

    def run_mise(self, *args, cwd=None):
        return subprocess.run(["mise", *args], cwd=cwd or self.root, env=self.env,
                              text=True, encoding="utf-8", capture_output=True)

    def test_discovery_creation_search_and_validation(self):
        listing = self.run_mise("tasks", "ls", "--json")
        self.assertEqual(listing.returncode, 0, listing.stderr)
        names = {task["name"] for task in json.loads(listing.stdout)}
        self.assertTrue({"docs:new", "docs:search", "docs:validate"}.issubset(names))
        self.assertFalse(any(name.startswith("docs:_lib:") for name in names))

        help_result = self.run_mise("run", "docs:new", "--help")
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("<type>", help_result.stdout)
        self.assertIn("<title>", help_result.stdout)

        created = self.run_mise("run", "docs:new", "adr", "日本語の設計判断")
        self.assertEqual(created.returncode, 0, created.stderr)
        document = json.loads(created.stdout)["document"]
        self.assertEqual(document["id"], "ADR-0001")
        path = self.root / document["path"]
        self.assertIn("日本語の設計判断", path.read_text(encoding="utf-8"))

        created = self.run_mise("run", "docs:new", "adr", "二件目")
        self.assertEqual(json.loads(created.stdout)["document"]["id"], "ADR-0002")
        second = self.root / "docs" / "decisions" / "0002.md"
        second.write_text(second.read_text(encoding="utf-8") + "\n[[ADR-0001]]\n", encoding="utf-8")

        search = self.run_mise("run", "docs:search", "日本語", cwd=self.root / "docs")
        self.assertEqual(search.returncode, 0, search.stderr)
        self.assertEqual(json.loads(search.stdout)["documents"][0]["path"], document["path"])
        missing = self.run_mise("run", "docs:search", "見つからない語句")
        self.assertEqual(json.loads(missing.stdout)["documents"], [])
        valid = self.run_mise("run", "docs:validate")
        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.assertEqual(json.loads(valid.stdout)["checked"], 2)

    def test_invalid_input_and_broken_documents(self):
        invalid = self.run_mise("run", "docs:new", "other", "題名")
        self.assertNotEqual(invalid.returncode, 0)
        self.assertFalse(json.loads(invalid.stdout)["ok"])
        self.assertFalse((self.root / "docs").exists())

        created = self.run_mise("run", "docs:new", "adr", "判断")
        self.assertEqual(created.returncode, 0, created.stderr)
        original = self.root / "docs" / "decisions" / "0001.md"
        duplicate = original.with_name("0001-copy.md")
        duplicate.write_text(original.read_text(encoding="utf-8") + "\n[[ADR-9999]]\n", encoding="utf-8")
        broken = original.with_name("0002.md")
        broken.write_text("---\nnot json\n---\n", encoding="utf-8")
        validation = self.run_mise("run", "docs:validate")
        self.assertNotEqual(validation.returncode, 0)
        errors = json.loads(validation.stdout)["errors"]
        self.assertTrue(any("重複" in item["message"] for item in errors))
        self.assertTrue(any("参照先" in item["message"] for item in errors))
        self.assertTrue(any("JSON" in item["message"] for item in errors))


if __name__ == "__main__":
    unittest.main()
