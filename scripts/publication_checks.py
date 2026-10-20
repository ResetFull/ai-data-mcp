"""Regression checks for manifest consistency and publication privacy boundaries."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from package_release import verify_versions
from privacy_check import inspect_bytes, path_issues, report, scan_archive

ROOT = Path(__file__).resolve().parents[1]


class PublicationChecks(unittest.TestCase):
    def test_should_align_public_and_compatibility_metadata(self):
        self.assertEqual(verify_versions()["license"], "Apache-2.0")
        manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
        self.assertLessEqual(len(manifest["extensions"]["com.openai"]["interface"]["shortDescription"]), 30)
        marketplace = json.loads((ROOT / ".agents/plugins/marketplace.json").read_text(encoding="utf-8"))
        self.assertEqual(marketplace["plugins"][0]["name"], manifest["name"])

    def test_should_default_every_example_connection_to_readonly(self):
        data = json.loads((ROOT / "config/connections.example.json").read_text())
        for provider in data.values():
            for connection in provider["connections"]:
                self.assertIs(connection["write_enabled"], False)

    def test_should_reject_private_paths_and_preserve_examples(self):
        for path in ("../escape", "config/secrets.json", ".env.local", "node_modules/package.json", "state/task.json"):
            self.assertTrue(path_issues(path), path)
        self.assertFalse(path_issues("config/secrets.example.json"))

    def test_should_report_only_locations_when_a_token_is_found(self):
        token = "ghp_" + "A" * 36
        findings = inspect_bytes("example.txt", token.encode())
        self.assertTrue(findings)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            report(findings)
        self.assertNotIn(token, output.getvalue())

    def test_should_reject_unsafe_final_archive_entries(self):
        with tempfile.TemporaryDirectory(prefix="data-mcp-package-") as directory:
            target = Path(directory) / "unsafe.zip"
            with zipfile.ZipFile(target, "w") as archive:
                archive.writestr("../outside.txt", "synthetic")
            self.assertIn("UNSAFE_PATH", {item["category"] for item in scan_archive(target)})


if __name__ == "__main__":
    unittest.main()
