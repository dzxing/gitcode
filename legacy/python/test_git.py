import io
import json
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import server


class GitIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gitk-test-")
        self.addCleanup(self.temp.cleanup)
        self.repo = self.temp.name
        self.path = Path(self.repo)
        server.git(self.repo, "init", "-b", "main")
        server.git(self.repo, "config", "user.name", "GitK Test")
        server.git(self.repo, "config", "user.email", "gitk@example.com")
        server.git(self.repo, "config", "commit.gpgsign", "false")

    def write(self, name="hello.txt", content="hello\n"):
        (self.path / name).write_text(content)

    def commit(self, message="first commit"):
        server.git(self.repo, "add", "--all")
        server.git(self.repo, "commit", "-m", message)
        return server.git(self.repo, "rev-parse", "HEAD").strip()

    def test_unborn_repository(self):
        self.write()
        state = server.snapshot(self.repo)
        self.assertEqual(state["branch"], "main")
        self.assertEqual(state["commits"], [])
        self.assertEqual(state["total"], 0)
        self.assertEqual(state["unstaged"], [{"path": "hello.txt", "status": "?"}])

    def test_stage_unstage_before_first_commit_preserves_file(self):
        self.write()
        server.action(self.repo, {"action": "stage", "paths": ["hello.txt"]})
        self.assertEqual(server.status(self.repo)[0][0]["status"], "A")
        server.action(self.repo, {"action": "unstage", "paths": ["hello.txt"]})
        self.assertFalse(server.status(self.repo)[0])
        self.assertEqual((self.path / "hello.txt").read_text(), "hello\n")

    def test_commit_only_staged_files_and_unicode_message(self):
        self.write()
        self.write("other.txt", "leave unstaged\n")
        server.action(self.repo, {"action": "stage", "paths": ["hello.txt"]})
        server.action(self.repo, {"action": "commit", "message": "feat: 中文提交\n\n详细说明"})
        state = server.snapshot(self.repo)
        self.assertEqual(state["commits"][0]["subject"], "feat: 中文提交")
        self.assertEqual(state["unstaged"][0]["path"], "other.txt")
        self.assertEqual(server.commit_files(self.repo, state["head"])["files"], [{"status": "A", "path": "hello.txt"}])

    def test_diff_staged_and_working_versions_are_distinct(self):
        self.write()
        self.commit()
        self.write(content="staged\n")
        server.action(self.repo, {"action": "stage", "paths": ["hello.txt"]})
        self.write(content="working\n")
        self.assertIn("+staged", server.diff(self.repo, {"path": "hello.txt", "staged": True})["diff"])
        self.assertIn("+working", server.diff(self.repo, {"path": "hello.txt"})["diff"])
        self.assertEqual(len(server.status(self.repo)[0]), 1)
        self.assertEqual(len(server.status(self.repo)[1]), 1)

    def test_untracked_diff_and_binary(self):
        self.write("新增.txt", "你好\n")
        self.assertIn("+你好", server.diff(self.repo, {"path": "新增.txt"})["diff"])
        (self.path / "image.bin").write_bytes(b"\x00\x01\xff")
        self.assertIn("Binary files", server.diff(self.repo, {"path": "image.bin"})["diff"])

    def test_log_parses_undecorated_commits(self):
        self.write()
        first = self.commit()
        self.write(content="second\n")
        second = self.commit("second")
        self.write(content="third\n")
        third = self.commit("third")
        commits = server.snapshot(self.repo)["commits"]
        self.assertEqual([c["hash"] for c in commits], [third, second, first])
        self.assertEqual(commits[1]["refs"], [])
        self.assertEqual(commits[1]["parents"], [first])

    def test_branch_creation_checkout_and_merge_topology(self):
        self.write()
        first = self.commit()
        server.action(self.repo, {"action": "branch", "name": "feature/demo"})
        self.write("feature.txt")
        feature = self.commit("feature")
        server.action(self.repo, {"action": "checkout", "name": "main"})
        self.write("main.txt")
        main = self.commit("main update")
        server.git(self.repo, "merge", "--no-ff", "feature/demo", "-m", "merge")
        state = server.snapshot(self.repo)
        self.assertEqual(state["commits"][0]["parents"], [main, feature])
        self.assertEqual(state["commits"][-1]["hash"], first)
        self.assertEqual(state["total"], 4)
        self.assertEqual([b["name"] for b in state["branches"] if b["current"]], ["main"])

    def test_detached_head_is_in_history(self):
        self.write()
        first = self.commit()
        server.git(self.repo, "checkout", "--detach", first)
        self.write(content="detached\n")
        detached = self.commit("detached update")
        state = server.snapshot(self.repo)
        self.assertEqual(state["branch"], "detached HEAD")
        self.assertEqual(state["commits"][0]["hash"], detached)

    def test_rename_unstage_restores_both_index_paths(self):
        self.write()
        self.commit()
        server.git(self.repo, "mv", "hello.txt", "renamed.txt")
        self.assertEqual(server.status(self.repo)[0][0]["oldPath"], "hello.txt")
        server.action(self.repo, {"action": "unstage", "paths": ["renamed.txt"]})
        self.assertFalse(server.status(self.repo)[0])
        self.assertTrue((self.path / "renamed.txt").exists())

    def test_literal_pathspec_and_unusual_filename(self):
        for name in ["[abc].txt", ":(glob)*", "space 文件.txt", "line\nfile.txt"]:
            self.write(name)
        server.action(self.repo, {"action": "stage", "paths": [":(glob)*"]})
        self.assertEqual([f["path"] for f in server.status(self.repo)[0]], [":(glob)*"])
        self.assertEqual(len(server.status(self.repo)[1]), 3)

    def test_checkout_refuses_overwriting_work(self):
        self.write()
        self.commit()
        server.action(self.repo, {"action": "branch", "name": "feature/demo"})
        self.write(content="feature\n")
        self.commit("feature")
        server.action(self.repo, {"action": "checkout", "name": "main"})
        self.write(content="unsaved\n")
        with self.assertRaises(server.GitError):
            server.action(self.repo, {"action": "checkout", "name": "feature/demo"})
        self.assertEqual((self.path / "hello.txt").read_text(), "unsaved\n")

    def test_rejects_invalid_and_stale_actions(self):
        for data in [
            {"action": "stage", "paths": ["../outside"]},
            {"action": "stage", "paths": ["not-a-change"]},
            {"action": "stage", "paths": []},
            {"action": "commit", "message": ""},
            {"action": "commit", "message": "no staged files"},
            {"action": "branch", "name": "--orphan"},
            {"action": "branch", "name": "bad name"},
            {"action": "reset"},
        ]:
            with self.subTest(data=data), self.assertRaises(server.GitError):
                server.action(self.repo, data)
        with self.assertRaises(server.GitError):
            server.diff(self.repo, {"path": "hello.txt", "commit": "HEAD;echo unsafe"})

    def test_diff_truncation(self):
        self.write(content="x" * (server.MAX_DIFF + 100))
        result = server.diff(self.repo, {"path": "hello.txt"})
        self.assertEqual(len(result["diff"]), server.MAX_DIFF)
        self.assertTrue(result["truncated"])

    def test_local_remote_operations(self):
        self.write()
        self.commit()
        with tempfile.TemporaryDirectory(prefix="gitk-remote-") as remote:
            server.git(remote, "init", "--bare")
            server.git(self.repo, "remote", "add", "origin", remote)
            server.git(self.repo, "push", "--set-upstream", "origin", "main")
            server.action(self.repo, {"action": "fetch"})
            server.action(self.repo, {"action": "pull"})
            self.write(content="next\n")
            self.commit("next")
            server.action(self.repo, {"action": "push"})
            self.assertEqual(server.git(remote, "rev-parse", "main"), server.git(self.repo, "rev-parse", "main"))

    def test_create_new_repository(self):
        target = self.path / "new-project"
        state = server.create_repository({"kind": "init", "path": str(target)})
        self.assertEqual(state["path"], str(target))
        self.assertEqual(state["branch"], "main")
        self.assertEqual(state["commits"], [])
        self.assertTrue((target / ".git").is_dir())

    def test_clone_local_repository(self):
        self.write()
        head = self.commit()
        with tempfile.TemporaryDirectory(prefix="gitk-clone-") as parent:
            target = Path(parent) / "cloned"
            state = server.create_repository({"kind": "clone", "path": str(target), "url": self.repo})
            self.assertEqual(state["head"], head)
            self.assertEqual((target / "hello.txt").read_text(), "hello\n")
            self.assertTrue(any(branch["kind"] == "remote" for branch in state["branches"]))

    def test_create_and_clone_reject_existing_destinations(self):
        self.write()
        for kind in ("init", "clone"):
            with self.subTest(kind=kind), self.assertRaises(server.GitError):
                server.create_repository({"kind": kind, "path": self.repo, "url": self.repo})
        self.assertEqual((self.path / "hello.txt").read_text(), "hello\n")

    def test_repository_creation_validation_has_no_side_effects(self):
        target = self.path / "should-not-exist"
        invalid = [
            {"kind": "delete", "path": str(target)},
            {"kind": "init", "path": "relative/path"},
            {"kind": "init", "path": str(target / "missing-parent" / "repo")},
            {"kind": "clone", "path": str(target), "url": "ext::sh -c unsafe"},
            {"kind": "clone", "path": str(target), "url": "--upload-pack=unsafe"},
            {"kind": "clone", "path": str(target), "url": ""},
        ]
        for data in invalid:
            with self.subTest(data=data), self.assertRaises(server.GitError):
                server.create_repository(data)
        self.assertFalse(target.exists())


class HttpBoundaryTests(unittest.TestCase):
    def handler(self, host="localhost:8765", origin=None, token=None, body=None, path="/api/action"):
        handler = server.Handler.__new__(server.Handler)
        handler.server = SimpleNamespace(server_port=8765)
        handler.headers = Message()
        handler.headers["Host"] = host
        if origin:
            handler.headers["Origin"] = origin
        if token:
            handler.headers["X-GitK-Token"] = token
        raw = json.dumps(body or {}).encode()
        handler.headers["Content-Length"] = str(len(raw))
        handler.path = path
        handler.rfile = io.BytesIO(raw)
        handler.wfile = io.BytesIO()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        return handler

    def test_origin_and_host_validation(self):
        self.assertTrue(self.handler().trusted())
        self.assertTrue(self.handler(origin="http://localhost:43187").trusted())
        self.assertFalse(self.handler(host="attacker.example:8765").trusted())
        self.assertFalse(self.handler(origin="https://attacker.example").trusted())

    def test_writes_require_session_token(self):
        handler = self.handler()
        handler.do_POST()
        handler.send_response.assert_called_with(403)

    def test_reads_require_token_except_session(self):
        handler = self.handler(path="/api/snapshot?repo=/tmp")
        handler.do_GET()
        handler.send_response.assert_called_with(403)
        session = self.handler(path="/api/session")
        session.do_GET()
        self.assertEqual(json.loads(session.wfile.getvalue())["token"], server.TOKEN)

    def test_invalid_payload_is_reported(self):
        handler = self.handler(token=server.TOKEN, body=[1, 2])
        handler.do_POST()
        handler.send_response.assert_called_with(400)

    def test_new_repository_endpoint_requires_token_and_returns_real_snapshot(self):
        handler = self.handler(path="/api/repositories")
        handler.do_POST()
        handler.send_response.assert_called_with(403)
        with tempfile.TemporaryDirectory(prefix="gitk-http-create-") as parent:
            target = str(Path(parent) / "new")
            handler = self.handler(path="/api/repositories", token=server.TOKEN, body={"kind": "init", "path": target})
            handler.do_POST()
            handler.send_response.assert_called_with(200)
            self.assertEqual(json.loads(handler.wfile.getvalue())["snapshot"]["path"], target)


if __name__ == "__main__":
    unittest.main()
