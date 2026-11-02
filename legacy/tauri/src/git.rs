use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env, fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, String>;
const MAX_DIFF: usize = 300_000;
const MAX_OUTPUT: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub platform: String,
    pub git_available: bool,
    pub git_version: String,
    pub git_path: String,
    pub git_error: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub refs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Branch {
    pub name: String,
    pub hash: String,
    pub current: bool,
    pub upstream: String,
    pub track: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub head: String,
    pub commits: Vec<Commit>,
    pub branches: Vec<Branch>,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub total: usize,
}

#[derive(Serialize)]
pub struct CommitDetails {
    pub files: Vec<FileChange>,
    pub body: String,
}
#[derive(Serialize)]
pub struct DiffResult {
    pub diff: String,
    pub truncated: bool,
}
#[derive(Serialize)]
pub struct ActionResult {
    pub output: String,
    pub snapshot: Snapshot,
}
#[derive(Serialize)]
pub struct CreateResult {
    pub snapshot: Snapshot,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum GitAction {
    Stage { paths: Vec<String> },
    Unstage { paths: Vec<String> },
    Commit { message: String },
    Branch { name: String },
    Checkout { name: String },
    Fetch,
    Pull,
    Push,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRequest {
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub url: String,
}

pub struct GitEngine {
    executable: Option<PathBuf>,
    version: String,
    pub cancel: Arc<AtomicBool>,
}

impl Default for GitEngine {
    fn default() -> Self {
        Self::discover()
    }
}

fn capture(reader: impl Read + Send + 'static) -> thread::JoinHandle<std::io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        reader.take(MAX_OUTPUT + 1).read_to_end(&mut bytes)?;
        Ok(bytes)
    })
}

fn configure_process(command: &mut Command) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000 | 0x0000_0200); // no console, own process group
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        // The child was started in its own process group. Kill SSH / hooks too,
        // otherwise they can retain stdout pipes after Git itself is killed.
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let taskkill = env::var_os("SystemRoot")
            .map(|root| PathBuf::from(root).join("System32/taskkill.exe"))
            .unwrap_or_else(|| PathBuf::from("taskkill.exe"));
        let _ = Command::new(taskkill)
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn execute(
    mut command: Command,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<(bool, String, String)> {
    if cancel.load(Ordering::Acquire) {
        return Err("Git 操作已取消。请刷新仓库确认最新状态。".into());
    }
    configure_process(&mut command);
    let mut child = command.spawn().map_err(|e| format!("无法启动 Git：{e}"))?;
    let stdout = capture(child.stdout.take().ok_or("无法读取 Git 标准输出。")?);
    let stderr = capture(child.stderr.take().ok_or("无法读取 Git 错误输出。")?);
    let started = Instant::now();
    let outcome = loop {
        if cancel.load(Ordering::Acquire) {
            kill_tree(&mut child);
            break Err("Git 操作已取消。取消不等于回滚，请刷新检查工作区与暂存区。".to_string());
        }
        if started.elapsed() > timeout {
            kill_tree(&mut child);
            break Err("Git 操作超时。请检查认证或连接，并刷新仓库确认状态。".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.success()),
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                kill_tree(&mut child);
                break Err(format!("无法等待 Git 进程：{error}"));
            }
        }
    };
    let out = stdout
        .join()
        .map_err(|_| "读取 Git 输出的线程异常退出。".to_string())?
        .map_err(|e| format!("读取 Git 输出失败：{e}"))?;
    let err = stderr
        .join()
        .map_err(|_| "读取 Git 错误的线程异常退出。".to_string())?
        .map_err(|e| format!("读取 Git 错误失败：{e}"))?;
    let success = outcome?;
    if out.len() as u64 > MAX_OUTPUT || err.len() as u64 > MAX_OUTPUT {
        return Err("Git 输出超过 32 MiB，请缩小仓库或文件范围。".into());
    }
    let output = String::from_utf8(out)
        .map_err(|_| "仓库包含无法用 UTF-8 表示的内容或路径，当前版本无法安全处理。".to_string())?;
    Ok((success, output, String::from_utf8_lossy(&err).into_owned()))
}

fn path_string(path: &Path) -> Result<String> {
    let value = path.to_str().ok_or("路径无法用 Unicode 表示。")?;
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return Ok(rest.into());
        }
    }
    Ok(value.into())
}

pub fn absolute_path(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.contains('\0') {
        return Err("请输入本机仓库的绝对路径。".into());
    }
    #[cfg(windows)]
    {
        let lower = value.to_lowercase().replace('/', "\\");
        let lower = if let Some(rest) = lower.strip_prefix(r"\\?\unc\") {
            format!(r"\\{rest}")
        } else {
            lower
        };
        if lower.starts_with(r"\\wsl.localhost\") || lower.starts_with(r"\\wsl$\") {
            return Err("此 Windows 版本暂不支持 WSL 仓库，请选择 Windows 本地仓库。".into());
        }
    }
    let path = if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        let home = if cfg!(windows) {
            env::var_os("USERPROFILE")
        } else {
            env::var_os("HOME")
        }
        .ok_or("无法定位用户目录，请输入绝对路径。")?;
        PathBuf::from(home).join(value.get(2..).unwrap_or(""))
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() {
        return Err("请使用当前操作系统中的绝对路径。".into());
    }
    Ok(path)
}

fn validate_file(value: &str) -> Result<()> {
    if value.is_empty()
        || value.contains('\0')
        || !Path::new(value)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("无效的仓库内文件路径。".into());
    }
    Ok(())
}

fn validate_revision(value: &str) -> Result<()> {
    if !(value.len() == 40 || value.len() == 64) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("无效的提交 ID。".into());
    }
    Ok(())
}

impl GitEngine {
    pub fn discover() -> Self {
        let mut candidates = Vec::new();
        if let Some(path) = env::var_os("GITK_GIT_PATH") {
            // An explicit override is authoritative; do not silently use another Git.
            candidates.push(PathBuf::from(path));
        } else {
            candidates.push(PathBuf::from(if cfg!(windows) { "git.exe" } else { "git" }));
            #[cfg(windows)]
            for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
                if let Some(root) = env::var_os(key) {
                    let root = PathBuf::from(root);
                    candidates.push(root.join("Git/cmd/git.exe"));
                    candidates.push(root.join("Programs/Git/cmd/git.exe"));
                }
            }
            #[cfg(target_os = "macos")]
            candidates.extend(
                [
                    "/opt/homebrew/bin/git",
                    "/usr/local/bin/git",
                    "/usr/bin/git",
                ]
                .map(PathBuf::from),
            );
        }
        let cancel = Arc::new(AtomicBool::new(false));
        for executable in candidates {
            let mut command = Command::new(&executable);
            command.arg("--version");
            if let Ok((true, version, _)) = execute(command, Duration::from_secs(3), &cancel) {
                return Self {
                    executable: Some(executable),
                    version: version.trim().into(),
                    cancel,
                };
            }
        }
        Self {
            executable: None,
            version: String::new(),
            cancel,
        }
    }

    pub fn runtime(&self) -> RuntimeInfo {
        RuntimeInfo {
            platform: env::consts::OS.into(),
            git_available: self.executable.is_some(),
            git_version: self.version.clone(),
            git_path: self
                .executable
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            git_error: if self.executable.is_none() {
                "未找到可用 Git。Windows 请安装 Git for Windows；macOS 请安装 Git。安装后重启 GitK，或设置 GITK_GIT_PATH 为 Git 可执行文件路径。".into()
            } else {
                String::new()
            },
        }
    }

    fn git(&self, repo: &Path, args: &[&str], optional: bool, seconds: u64) -> Result<String> {
        let executable = self
            .executable
            .as_ref()
            .ok_or_else(|| self.runtime().git_error)?;
        let mut command = Command::new(executable);
        command
            .current_dir(repo)
            .args([
                "--no-pager",
                "--literal-pathspecs",
                "-c",
                "core.quotePath=false",
            ])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0");
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_NAMESPACE",
            "GIT_CONFIG_COUNT",
        ] {
            command.env_remove(key);
        }
        let (success, out, err) = execute(command, Duration::from_secs(seconds), &self.cancel)?;
        if !success && !optional {
            return Err(if err.trim().is_empty() {
                out.trim().into()
            } else {
                err.trim().into()
            });
        }
        Ok(if success || !optional {
            out
        } else {
            String::new()
        })
    }

    fn read(&self, repo: &Path, args: &[&str]) -> Result<String> {
        self.git(repo, args, false, 30)
    }

    pub fn repository(&self, value: &str) -> Result<PathBuf> {
        let path = absolute_path(value)?;
        if !path.is_dir() {
            return Err("目录不存在，请选择本机仓库目录。".into());
        }
        if self
            .read(&path, &["rev-parse", "--is-bare-repository"])?
            .trim()
            == "true"
        {
            return Err("暂不支持裸仓库，请打开带工作区的仓库。".into());
        }
        let root = self.read(&path, &["rev-parse", "--show-toplevel"])?;
        fs::canonicalize(root.trim_end_matches(['\r', '\n']))
            .map_err(|e| format!("无法定位仓库：{e}"))
    }

    fn status(&self, repo: &Path) -> Result<(Vec<FileChange>, Vec<FileChange>)> {
        parse_status(&self.read(
            repo,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?)
    }

    pub fn snapshot(&self, repo: &Path) -> Result<Snapshot> {
        let head = self
            .git(repo, &["rev-parse", "--verify", "HEAD"], true, 30)?
            .trim()
            .to_string();
        let branch = self
            .git(repo, &["symbolic-ref", "--short", "-q", "HEAD"], true, 30)?
            .trim()
            .to_string();
        let mut commits = Vec::new();
        // Unborn branches can still have other local / remote refs to display.
        let mut args = vec!["log", "--all"];
        if !head.is_empty() {
            args.push("HEAD");
        }
        args.extend([
            "--topo-order",
            "-n",
            "250",
            "-z",
            "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00%D",
        ]);
        let raw = self.git(repo, &args, true, 30)?;
        let fields: Vec<_> = raw.split('\0').collect();
        for record in fields.chunks_exact(7) {
            commits.push(Commit {
                hash: record[0].into(),
                parents: record[1].split_whitespace().map(String::from).collect(),
                subject: record[2].into(),
                author: record[3].into(),
                email: record[4].into(),
                date: record[5].into(),
                refs: record[6]
                    .split(", ")
                    .filter(|v| !v.is_empty())
                    .map(String::from)
                    .collect(),
            });
        }
        let mut branches = Vec::new();
        let refs = self.read(repo, &["for-each-ref", "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)", "refs/heads", "refs/remotes", "refs/tags"])?;
        for line in refs.lines() {
            let fields: Vec<_> = line.split('\0').collect();
            if fields.len() != 5 {
                return Err("无法解析 Git 引用。".into());
            }
            let (prefix, kind) = if fields[0].starts_with("refs/heads/") {
                ("refs/heads/", "local")
            } else if fields[0].starts_with("refs/remotes/") {
                ("refs/remotes/", "remote")
            } else {
                ("refs/tags/", "tag")
            };
            branches.push(Branch {
                name: fields[0].trim_start_matches(prefix).into(),
                hash: fields[1].into(),
                current: fields[2] == "*",
                upstream: fields[3].into(),
                track: fields[4].into(),
                kind: kind.into(),
            });
        }
        let (staged, unstaged) = self.status(repo)?;
        let mut count_args = vec!["rev-list", "--all"];
        if !head.is_empty() {
            count_args.push("HEAD");
        }
        count_args.push("--count");
        let total = self
            .read(repo, &count_args)?
            .trim()
            .parse::<usize>()
            .map_err(|_| "无法解析提交数量。".to_string())?;
        Ok(Snapshot {
            path: path_string(repo)?,
            name: repo
                .file_name()
                .and_then(|p| p.to_str())
                .unwrap_or("repository")
                .into(),
            branch: if branch.is_empty() {
                "detached HEAD".into()
            } else {
                branch
            },
            head,
            commits,
            branches,
            staged,
            unstaged,
            total,
        })
    }

    fn commit_base(&self, repo: &Path, sha: &str) -> Result<String> {
        validate_revision(sha)?;
        let parents = self.read(repo, &["rev-list", "--parents", "-n", "1", sha])?;
        match parents.split_whitespace().nth(1) {
            Some(parent) => Ok(parent.into()),
            None => self
                .read(repo, &["hash-object", "-t", "tree", "--stdin"])
                .map(|s| s.trim().into()),
        }
    }

    pub fn commit_details(&self, repo: &Path, sha: &str) -> Result<CommitDetails> {
        let base = self.commit_base(repo, sha)?;
        let raw = self.read(
            repo,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--name-status",
                "-z",
                &base,
                sha,
                "--",
            ],
        )?;
        let fields: Vec<_> = raw.split('\0').collect();
        let files = fields
            .chunks_exact(2)
            .map(|r| FileChange {
                status: r[0].into(),
                path: r[1].into(),
                old_path: None,
            })
            .collect();
        Ok(CommitDetails {
            files,
            body: self
                .read(repo, &["show", "-s", "--format=%B", sha])?
                .trim_end()
                .into(),
        })
    }

    pub fn diff(
        &self,
        repo: &Path,
        path: &str,
        staged: bool,
        commit: Option<&str>,
    ) -> Result<DiffResult> {
        validate_file(path)?;
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
        let base;
        if let Some(sha) = commit {
            base = self.commit_base(repo, sha)?;
            args.extend([&base, sha]);
        } else if staged {
            args.push("--cached");
        }
        args.extend(["--", path]);
        let mut output = self.read(repo, &args)?;
        if commit.is_none()
            && !staged
            && output.is_empty()
            && self
                .status(repo)?
                .1
                .iter()
                .any(|f| f.path == path && f.status == "?")
        {
            let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
            // `--no-index` returns 1 when files differ. Other errors must surface.
            let executable = self
                .executable
                .as_ref()
                .ok_or_else(|| self.runtime().git_error)?;
            let mut command = Command::new(executable);
            command.current_dir(repo).args([
                "--no-pager",
                "--literal-pathspecs",
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--no-index",
                "--",
                null,
                path,
            ]);
            let (_, out, err) = execute(command, Duration::from_secs(30), &self.cancel)?;
            if out.is_empty() && !err.trim().is_empty() {
                return Err(err.trim().into());
            }
            output = out;
        }
        let truncated = output.chars().count() > MAX_DIFF;
        Ok(DiffResult {
            diff: output.chars().take(MAX_DIFF).collect(),
            truncated,
        })
    }

    pub fn action(&self, repo: &Path, request: GitAction) -> Result<ActionResult> {
        let output = match request {
            GitAction::Stage { paths } => self.update_index(repo, paths, false)?,
            GitAction::Unstage { paths } => self.update_index(repo, paths, true)?,
            GitAction::Commit { message } => {
                if message.trim().is_empty() || message.chars().count() > 20_000 {
                    return Err("请填写提交说明，最多 20000 字符。".into());
                }
                if self.status(repo)?.0.is_empty() {
                    return Err("请先暂存需要提交的文件。".into());
                }
                self.git(repo, &["commit", "-m", message.trim()], false, 300)?
            }
            GitAction::Branch { name } => {
                self.validate_branch(repo, &name)?;
                self.read(repo, &["switch", "-c", &name])?
            }
            GitAction::Checkout { name } => {
                self.validate_branch(repo, &name)?;
                self.read(
                    repo,
                    &["show-ref", "--verify", "--", &format!("refs/heads/{name}")],
                )?;
                self.read(repo, &["switch", &name])?
            }
            GitAction::Fetch => self.git(repo, &["fetch", "--all"], false, 300)?,
            GitAction::Pull => self.git(repo, &["pull", "--ff-only"], false, 300)?,
            GitAction::Push => self.git(repo, &["push"], false, 300)?,
        };
        Ok(ActionResult {
            output,
            snapshot: self.snapshot(repo)?,
        })
    }

    fn validate_branch(&self, repo: &Path, name: &str) -> Result<()> {
        if name.is_empty() || name.starts_with('-') || name.contains('\0') {
            return Err("无效的分支名称。".into());
        }
        self.read(repo, &["check-ref-format", "--branch", name])?;
        Ok(())
    }

    fn update_index(&self, repo: &Path, paths: Vec<String>, unstage: bool) -> Result<String> {
        if paths.is_empty() || paths.len() > 5000 {
            return Err("请选择要操作的文件。".into());
        }
        for path in &paths {
            validate_file(path)?;
        }
        let (staged, unstaged) = self.status(repo)?;
        let files = if unstage { staged } else { unstaged };
        let allowed: HashSet<_> = files.iter().map(|file| file.path.as_str()).collect();
        if paths.iter().any(|p| !allowed.contains(p.as_str())) {
            return Err("文件状态已变化，请刷新后重试。".into());
        }
        let mut expanded = paths.clone();
        for file in &files {
            if paths.contains(&file.path) {
                if let Some(old) = &file.old_path {
                    expanded.push(old.clone());
                }
            }
        }
        let mut args = if !unstage {
            vec!["add", "--"]
        } else if self
            .git(repo, &["rev-parse", "--verify", "HEAD"], true, 30)?
            .trim()
            .is_empty()
        {
            vec!["rm", "--cached", "--"]
        } else {
            vec!["restore", "--staged", "--"]
        };
        args.extend(expanded.iter().map(String::as_str));
        self.read(repo, &args)
    }

    pub fn create(&self, request: CreateRequest) -> Result<CreateResult> {
        if request.kind != "init" && request.kind != "clone" {
            return Err("请选择创建或克隆仓库。".into());
        }
        let target = absolute_path(&request.path)?;
        if fs::symlink_metadata(&target).is_ok() {
            return Err("目标目录已存在，请选择尚未创建的新目录。".into());
        }
        let parent = target.parent().ok_or("父目录不存在。")?;
        let parent =
            fs::canonicalize(parent).map_err(|_| "父目录不存在，请先创建父目录。".to_string())?;
        if !parent.is_dir() {
            return Err("父目录不是一个目录。".into());
        }
        let target = parent.join(target.file_name().ok_or("无效的目标目录名称。")?);
        let url = request.url.trim();
        if request.kind == "clone" && !valid_remote(url) {
            return Err("请使用 HTTPS、SSH 地址或本地仓库绝对路径。".into());
        }
        if self.executable.is_none() {
            return Err(self.runtime().git_error);
        }
        fs::create_dir(&target).map_err(|e| format!("无法创建新目录：{e}"))?;
        let target_string = path_string(&target)?;
        if request.kind == "init" {
            self.read(
                &parent,
                &["init", "--initial-branch=main", "--", &target_string],
            )?;
        } else {
            self.git(
                &parent,
                &[
                    "-c",
                    "protocol.ext.allow=never",
                    "clone",
                    "--",
                    url,
                    &target_string,
                ],
                false,
                300,
            )?;
        }
        Ok(CreateResult {
            snapshot: self.snapshot(&self.repository(&target_string)?)?,
        })
    }
}

fn valid_remote(value: &str) -> bool {
    if value.is_empty() || value.contains('\0') || value.starts_with('-') {
        return false;
    }
    if Path::new(value).is_absolute()
        || ["https://", "http://", "ssh://", "git://", "file://"]
            .iter()
            .any(|prefix| value.starts_with(prefix))
    {
        return true;
    }
    if let Some((user, rest)) = value.split_once('@') {
        if let Some((host, path)) = rest.split_once(':') {
            return !user.is_empty()
                && !host.is_empty()
                && !path.is_empty()
                && user
                    .bytes()
                    .chain(host.bytes())
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
        }
    }
    false
}

fn parse_status(raw: &str) -> Result<(Vec<FileChange>, Vec<FileChange>)> {
    let mut records = raw.split('\0');
    let (mut staged, mut unstaged) = (Vec::new(), Vec::new());
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || !record.is_char_boundary(3) {
            return Err("无法解析 Git 文件状态。".into());
        }
        let code = &record[..2];
        let old_path = if code.contains('R') || code.contains('C') {
            Some(records.next().ok_or("重命名记录缺少原路径。")?.into())
        } else {
            None
        };
        let file = FileChange {
            path: record[3..].into(),
            status: String::new(),
            old_path,
        };
        if code == "??" {
            unstaged.push(FileChange {
                status: "?".into(),
                ..file
            });
        } else if ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].contains(&code) {
            unstaged.push(FileChange {
                status: "U".into(),
                ..file
            });
        } else {
            if code.as_bytes()[0] != b' ' {
                staged.push(FileChange {
                    status: code[..1].into(),
                    ..file.clone()
                });
            }
            if code.as_bytes()[1] != b' ' {
                unstaged.push(FileChange {
                    status: code[1..].into(),
                    ..file
                });
            }
        }
    }
    Ok((staged, unstaged))
}

#[cfg(test)]
mod tests;
