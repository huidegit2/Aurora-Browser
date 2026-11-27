import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("release_version", Path(__file__).resolve().parents[1] / "scripts" / "release_version.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseVersionTests(unittest.TestCase):
    def test_first_automatic_release(self):
        self.assertEqual(module.resolve_version("1.0.23", ["v1.0.22", "v1.0.23", "v1.013"]), "1.0.24")

    def test_numeric_tag_order(self):
        self.assertEqual(module.resolve_version("1.0.9", ["v1.0.9", "v1.0.10"]), "1.0.11")

    def test_declared_major_version_is_respected(self):
        self.assertEqual(module.resolve_version("2.0.0", ["v1.0.23"]), "2.0.0")

    def test_no_existing_tags(self):
        self.assertEqual(module.resolve_version("1.0.0", []), "1.0.0")

    def test_invalid_and_prerelease_tags_are_ignored(self):
        self.assertEqual(module.resolve_version("1.0.23", ["v1.0.23", "preview", "v9.0.0-rc.1", "v1.013"]), "1.0.24")

    def test_explicit_version(self):
        self.assertEqual(module.resolve_version("1.0.23", ["v1.0.23"], requested="v1.0.24"), "1.0.24")

    def test_tag_trigger_uses_tag(self):
        self.assertEqual(module.resolve_version("1.0.23", [], ref_type="tag", ref_name="v1.0.25"), "1.0.25")

    def test_rerun_reuses_tag_at_the_same_commit(self):
        self.assertEqual(module.resolve_version("1.0.23", ["v1.0.23", "v1.0.24"], head_tags=["v1.0.24"]), "1.0.24")

    def test_new_commit_bumps_after_previous_release(self):
        self.assertEqual(module.resolve_version("1.0.23", ["v1.0.23", "v1.0.24"], head_tags=[]), "1.0.25")

    def test_reject_unsafe_or_invalid_input(self):
        for value in ["main", "1.0", "1.0.24; echo bad", "1.0.24\nother", "01.0.24", "-1.0.24"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.resolve_version("1.0.23", [], requested=value)

    def test_stamp_only_version_fields(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            server = root / "app" / "server"
            server.mkdir(parents=True)
            (root / "manifest").write_text("appname = fn-browser\nversion = 1.0.23\nplatform = arm\n", encoding="utf-8")
            package = {"name": "aurora", "version": "1.0.23", "dependencies": {"example": "1.2.3"}}
            lock = {"version": "1.0.23", "packages": {"": {"version": "1.0.23"}, "node_modules/example": {"version": "1.2.3"}}}
            (server / "package.json").write_text(json.dumps(package), encoding="utf-8")
            (server / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
            module.stamp_version(root, "1.0.24")
            self.assertEqual((root / "manifest").read_text(), "appname = fn-browser\nversion = 1.0.24\nplatform = arm\n")
            self.assertEqual(json.loads((server / "package.json").read_text())["dependencies"], package["dependencies"])
            saved = json.loads((server / "package-lock.json").read_text())
            self.assertEqual(saved["version"], "1.0.24")
            self.assertEqual(saved["packages"][""]["version"], "1.0.24")
            self.assertEqual(saved["packages"]["node_modules/example"]["version"], "1.2.3")


if __name__ == "__main__":
    unittest.main()
