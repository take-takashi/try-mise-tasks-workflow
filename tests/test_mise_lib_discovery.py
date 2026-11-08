"""mise の File Task と Python ライブラリの扱いを確認する。"""

import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.name == "posix", "実行権限による判定は POSIX 環境で確認する")
class MiseLibraryDiscoveryTest(unittest.TestCase):
    def test_project_library_modules_are_not_executable(self):
        project = Path(__file__).resolve().parent.parent
        for tasks in (project / ".mise" / "tasks", project / "mise-tasks"):
            if tasks.is_dir():
                for library in tasks.rglob("_lib"):
                    if library.is_dir():
                        for module in library.rglob("*.py"):
                            with self.subTest(module=module):
                                self.assertEqual(module.stat().st_mode & 0o111, 0, str(module))

    def test_library_is_importable_but_not_a_task(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task_dir = root / ".mise" / "tasks" / "docs"
            library = task_dir / "_lib"
            library.mkdir(parents=True)
            (library / "__init__.py").write_text("", encoding="utf-8")
            module = library / "example.py"
            module.write_text('def message():\n    return "import-ok"\n', encoding="utf-8")
            task = task_dir / "probe"
            task.write_text(
                '#!/usr/bin/env python3\nfrom _lib.example import message\nprint(message())\n',
                encoding="utf-8",
            )
            task.chmod(0o755)

            self.assertEqual(module.stat().st_mode & 0o111, 0)
            environment = os.environ.copy()
            environment["MISE_YES"] = "1"
            listing = subprocess.run(
                ["mise", "tasks", "ls", "--json"], cwd=root, env=environment,
                check=True, capture_output=True, text=True, encoding="utf-8",
            )
            names = {entry["name"] for entry in json.loads(listing.stdout)}
            self.assertIn("docs:probe", names)
            self.assertFalse(any(name.startswith("docs:_lib:") for name in names))

            result = subprocess.run(
                ["mise", "run", "docs:probe"], cwd=root, env=environment,
                check=True, capture_output=True, text=True, encoding="utf-8",
            )
            self.assertEqual(result.stdout.strip(), "import-ok")

            module.chmod(module.stat().st_mode | stat.S_IXUSR)
            listing = subprocess.run(
                ["mise", "tasks", "ls", "--json"], cwd=root, env=environment,
                check=True, capture_output=True, text=True, encoding="utf-8",
            )
            names = {entry["name"] for entry in json.loads(listing.stdout)}
            self.assertIn("docs:_lib:example", names)


if __name__ == "__main__":
    unittest.main()
