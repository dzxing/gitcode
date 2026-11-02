"""GitK's dependency-free, loopback-only Git service and static server."""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
TOKEN = secrets.token_urlsafe(32)
WRITE_LOCK = threading.Lock()
INITIAL_REPO = ""
MAX_DIFF = 300_000


class GitError(Exception):
    pass


def git(repo: str, *args: str, allow_failure: bool = False, timeout: int = 30) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C.UTF-8"}
    try:
        result = subprocess.run(
            ["git", "--no-pager", "--literal-pathspecs", "-c", "core.quotePath=false", "-C", repo, *args],
            capture_output=True, input=b"", timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise GitError("Git 操作超时，请检查仓库或远程连接。") from exc
    output = result.stdout.decode("utf-8", errors="replace")
    if result.returncode and not allow_failure:
        raise GitError(result.stderr.decode("utf-8", errors="replace").strip() or output.strip() or "Git 操作失败")
    return output


def repository(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GitError("请输入本机仓库的绝对路径。")
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise GitError("目录不存在，请输入 WSL / Linux 中的仓库路径。")
    if git(str(path), "rev-parse", "--is-bare-repository").strip() == "true":
        raise GitError("暂不支持裸仓库，请打开带工作区的仓库。")
    return git(str(path), "rev-parse", "--show-toplevel").strip()


def file_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\0" in value or value.startswith("/") or ".." in Path(value).parts:
        raise GitError("无效的文件路径。")
    return value


def revision(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-fA-F0-9]{40,64}", value):
        raise GitError("无效的提交 ID。")
    return value


def status(repo: str) -> tuple[list[dict], list[dict]]:
    records = iter(git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0"))
    staged, unstaged = [], []
    for entry in records:
        if not entry:
            continue
        code, path = entry[:2], entry[3:]
        item = {"path": path}
        if "R" in code or "C" in code:
            item["oldPath"] = next(records, "")
        if code == "??":
            unstaged.append({**item, "status": "?"})
        elif code in ("DD", "AU", "UD", "UA", "DU", "AA", "UU"):
            unstaged.append({**item, "status": "U"})
        else:
            if code[0] != " ":
                staged.append({**item, "status": code[0]})
            if code[1] != " ":
                unstaged.append({**item, "status": code[1]})
    return staged, unstaged


def snapshot(repo: str) -> dict:
    head = git(repo, "rev-parse", "--verify", "HEAD", allow_failure=True).strip()
    branch = git(repo, "symbolic-ref", "--short", "-q", "HEAD", allow_failure=True).strip()
    commits = []
    if head:
        raw = git(repo, "log", "--all", "HEAD", "--topo-order", "-n", "250", "-z",
                  "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%D")
        # Keep empty decoration fields: they are valid for ordinary commits.
        fields = raw.split("\0")
        for offset in range(0, len(fields) - 1, 7):
            h, parents, subject, author, email, date, refs = fields[offset:offset + 7]
            commits.append(dict(hash=h, parents=parents.split(), subject=subject, author=author,
                                email=email, date=date, refs=[r for r in refs.split(", ") if r]))
    branches = []
    for line in git(repo, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)",
                    "refs/heads", "refs/remotes", "refs/tags").splitlines():
        ref, h, current, upstream, track = line.split("\0")
        kind = "local" if ref.startswith("refs/heads/") else "remote" if ref.startswith("refs/remotes/") else "tag"
        name = ref.removeprefix({"local": "refs/heads/", "remote": "refs/remotes/", "tag": "refs/tags/"}[kind])
        branches.append(dict(name=name, hash=h, current=current == "*", upstream=upstream, track=track, kind=kind))
    staged, unstaged = status(repo)
    total = int(git(repo, "rev-list", "--all", "HEAD", "--count").strip() or "0") if head else 0
    return dict(path=repo, name=Path(repo).name, branch=branch or "detached HEAD", head=head,
                branches=branches, commits=commits, staged=staged, unstaged=unstaged, total=total)


def commit_files(repo: str, sha: str) -> dict:
    sha = revision(sha)
    # Diff against first parent for merges and the empty tree for a root commit.
    parents = git(repo, "rev-list", "--parents", "-n", "1", sha).split()[1:]
    base = parents[0] if parents else git(repo, "hash-object", "-t", "tree", "--stdin").strip()
    parts = git(repo, "diff", "--no-renames", "--name-status", "-z", base, sha, "--").split("\0")
    files, i = [], 0
    while i < len(parts) - 1:
        code, path = parts[i:i + 2]
        files.append({"status": code, "path": path})
        i += 2
    return {"files": files, "body": git(repo, "show", "-s", "--format=%B", sha).strip()}


def diff(repo: str, data: dict) -> dict:
    path = file_path(data.get("path", ""))
    if data.get("commit"):
        sha = revision(data["commit"])
        parents = git(repo, "rev-list", "--parents", "-n", "1", sha).split()[1:]
        base = parents[0] if parents else git(repo, "hash-object", "-t", "tree", "--stdin").strip()
        output = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", base, sha, "--", path)
    elif data.get("staged"):
        output = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--cached", "--", path)
    else:
        output = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", path)
        if not output and any(f["path"] == path and f["status"] == "?" for f in status(repo)[1]):
            output = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-index", "--", "/dev/null", path, allow_failure=True)
    return {"diff": output[:MAX_DIFF], "truncated": len(output) > MAX_DIFF}


def action(repo: str, data: dict) -> str:
    op = data.get("action")
    if op in ("stage", "unstage"):
        paths = data.get("paths")
        if not isinstance(paths, list) or not paths or len(paths) > 5000:
            raise GitError("请选择要操作的文件。")
        paths = [file_path(p) for p in paths]
        # Only operate on paths currently reported by Git; no arbitrary pathspecs.
        staged, unstaged = status(repo)
        allowed = {f["path"] for f in (unstaged if op == "stage" else staged)}
        if any(p not in allowed for p in paths):
            raise GitError("文件状态已变化，请刷新后重试。")
        expanded = list(paths)
        for item in (unstaged if op == "stage" else staged):
            if item["path"] in paths and item.get("oldPath"):
                expanded.append(item["oldPath"])
        if op == "stage":
            return git(repo, "add", "--", *expanded)
        if git(repo, "rev-parse", "--verify", "HEAD", allow_failure=True).strip():
            return git(repo, "restore", "--staged", "--", *expanded)
        return git(repo, "rm", "--cached", "--", *expanded)
    if op == "commit":
        message = data.get("message", "")
        if not isinstance(message, str) or not message.strip() or len(message) > 20000:
            raise GitError("请填写提交说明（最多 20000 字符）。")
        if not status(repo)[0]:
            raise GitError("请先暂存需要提交的文件。")
        return git(repo, "commit", "-m", message.strip())
    if op in ("branch", "checkout"):
        name = data.get("name", "")
        if not isinstance(name, str) or name.startswith("-") or not name:
            raise GitError("无效的分支名。")
        git(repo, "check-ref-format", "--branch", name)
        if op == "branch":
            return git(repo, "switch", "-c", name)
        names = {b["name"] for b in snapshot(repo)["branches"] if b["kind"] == "local"}
        if name not in names:
            raise GitError("请选择已有的本地分支。")
        return git(repo, "switch", name)
    if op == "fetch":
        return git(repo, "fetch", "--all")
    if op == "pull":
        return git(repo, "pull", "--ff-only")
    if op == "push":
        return git(repo, "push")
    raise GitError("不支持的操作。")


def create_repository(data: dict) -> dict:
    kind = data.get("kind")
    value = data.get("path", "")
    if kind not in ("init", "clone"):
        raise GitError("请选择创建或克隆仓库。")
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise GitError("请输入新仓库的绝对路径。")
    target = Path(value.strip()).expanduser()
    if not target.is_absolute():
        raise GitError("目标目录必须是绝对路径。")
    # Require a new directory, including rejecting symlinks and existing repos.
    if target.exists() or target.is_symlink():
        raise GitError("目标目录已存在，请选择一个尚不存在的新目录。")
    parent = target.parent.resolve()
    if not parent.is_dir():
        raise GitError("父目录不存在，请先创建父目录。")
    target = parent / target.name
    url = data.get("url", "")
    if kind == "clone":
        if not isinstance(url, str) or not url.strip() or "\0" in url:
            raise GitError("请输入 Git 仓库地址。")
        url = url.strip()
        if not (url.startswith(("https://", "http://", "ssh://", "git://", "file://", "/"))
                or re.fullmatch(r"[\w.-]+@[\w.-]+:.+", url)):
            raise GitError("请使用 HTTPS、SSH 地址或本地仓库绝对路径。")
    # Reserve exclusively so a pre-existing directory is never reinitialized.
    target.mkdir()
    if kind == "init":
        git(str(parent), "init", "--initial-branch=main", "--", str(target))
    else:
        git(str(parent), "-c", "protocol.ext.allow=never", "clone", "--", url, str(target), timeout=300)
    return snapshot(repository(str(target)))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "dist"), **kwargs)

    def trusted(self) -> bool:
        host = self.headers.get("Host", "")
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}",
                   "127.0.0.1:43187", "localhost:43187"}
        origin = self.headers.get("Origin")
        return host in allowed and (not origin or origin in {f"http://{h}" for h in allowed})

    def send_json(self, value: dict, status_code: int = 200):
        raw = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not self.trusted():
            return self.send_json({"error": "不允许访问此本地服务。"}, 403)
        parsed = urlparse(self.path)
        if parsed.path == "/api/session":
            return self.send_json({"token": TOKEN, "initialRepo": INITIAL_REPO})
        if parsed.path.startswith("/api/"):
            if not secrets.compare_digest(self.headers.get("X-GitK-Token", ""), TOKEN):
                return self.send_json({"error": "会话已失效，请刷新页面。"}, 403)
            try:
                query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
                repo = repository(query.get("repo", ""))
                if parsed.path == "/api/snapshot":
                    return self.send_json(snapshot(repo))
                if parsed.path == "/api/commit":
                    return self.send_json(commit_files(repo, query.get("commit", "")))
                if parsed.path == "/api/diff":
                    query["staged"] = query.get("staged") == "true"
                    return self.send_json(diff(repo, query))
                return self.send_json({"error": "接口不存在。"}, 404)
            except (GitError, OSError, ValueError) as exc:
                return self.send_json({"error": str(exc)}, 400)
        if not (ROOT / "dist" / "index.html").exists():
            return self.send_json({"error": "请先运行 npm install 和 npm run build，再打开此页面。"}, 503)
        return super().do_GET()

    def do_POST(self):
        if not self.trusted() or not secrets.compare_digest(self.headers.get("X-GitK-Token", ""), TOKEN):
            return self.send_json({"error": "请求验证失败，请刷新页面。"}, 403)
        endpoint = urlparse(self.path).path
        if endpoint not in ("/api/action", "/api/repositories"):
            return self.send_json({"error": "接口不存在。"}, 404)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 1_000_000:
                raise GitError("请求大小无效。")
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise GitError("请求格式无效。")
            if endpoint == "/api/repositories":
                with WRITE_LOCK:
                    state = create_repository(data)
                return self.send_json({"snapshot": state})
            repo = repository(data.get("repo", ""))
            with WRITE_LOCK:
                output = action(repo, data)
            self.send_json({"output": output, "snapshot": snapshot(repo)})
        except (GitError, OSError, ValueError, TypeError) as exc:
            self.send_json({"error": str(exc)}, 400)


def main():
    global INITIAL_REPO
    parser = argparse.ArgumentParser(description="GitK 本地 Git 工作台")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--repo", default="", help="启动时打开的 Git 仓库路径")
    args = parser.parse_args()
    INITIAL_REPO = repository(args.repo) if args.repo else ""
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"GitK 已启动：http://localhost:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
