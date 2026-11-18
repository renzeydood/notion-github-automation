"""Regression tests for merge-to-Done Notion synchronization."""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("lifecycle", ROOT / "scripts/sync_github_lifecycle.py")
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


class MergeToDoneTests(unittest.TestCase):
    def run_event(self, lifecycle_state, ticket_status, *, action="closed", merged=True, status_type="status"):
        branch = "feature/MAP-86_validate_notion_integration"
        event = {
            "action": action,
            "pull_request": {
                "head": {"ref": branch, "repo": {"full_name": "renzeydood/MapPinList"}},
                "merged": merged,
                "html_url": "https://github.com/renzeydood/MapPinList/pull/8",
            },
        }
        props = {
            "GitHub Lifecycle": {"select": {"name": lifecycle_state}},
            "GitHub Link": {"url": event["pull_request"]["html_url"] if lifecycle_state == "Merged" else None},
            "Status": {"type": status_type, status_type: {"name": ticket_status}},
        }
        page = {"id": "sample-page-id", "properties": props}
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "event.json"
            path.write_text(json.dumps(event), encoding="utf-8")
            env = {
                "GITHUB_EVENT_PATH": str(path),
                "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_REPOSITORY": "renzeydood/MapPinList",
            }
            def fake_notion(method, endpoint, version, payload=None):
                calls.append((method, endpoint, payload))
                return {}
            with patch.dict(os.environ, env), patch.object(lifecycle, "notion_api_settings", return_value=("2025-09-03", "/data_sources/example/query")), patch.object(lifecycle, "find_ticket", return_value=page), patch.object(lifecycle, "notion", side_effect=fake_notion):
                lifecycle.main()
        return calls

    def test_merge_marks_in_progress_done(self):
        calls = self.run_event("PR", "In Progress")
        self.assertEqual(len(calls), 1)
        update = calls[0][2]["properties"]
        self.assertEqual(update["GitHub Lifecycle"]["select"]["name"], "Merged")
        self.assertEqual(update["Status"]["status"]["name"], "Done")

    def test_repeated_merge_repairs_missing_done(self):
        calls = self.run_event("Merged", "To Do")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2]["properties"]["Status"]["status"]["name"], "Done")

    def test_repeated_merge_done_is_idempotent(self):
        self.assertEqual(self.run_event("Merged", "Done"), [])

    def test_pr_open_does_not_change_status(self):
        calls = self.run_event("Created", "To Do", action="opened", merged=False)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("Status", calls[0][2]["properties"])

    def test_unmerged_close_does_nothing(self):
        self.assertEqual(self.run_event("PR", "In Progress", merged=False), [])

    def test_select_status_supported(self):
        calls = self.run_event("PR", "In Progress", status_type="select")
        self.assertEqual(calls[0][2]["properties"]["Status"]["select"]["name"], "Done")


if __name__ == "__main__":
    unittest.main()
