use super::*;
use std::sync::atomic::AtomicUsize;

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Repo {
    path: PathBuf,
    engine: GitEngine,
}
impl Repo {
    fn new() -> Self {
        let path = env::temp_dir().join(format!(
            "gitk-{}-{}-中文 project",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let engine = GitEngine::discover();
        assert!(engine.runtime().git_available, "Tests require Git on PATH");
        engine.read(&path, &["init", "-b", "main"]).unwrap();
        for (key, value) in [
            ("user.name", "GitK Test"),
            ("user.email", "gitk@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.hooksPath", ".gitk-no-hooks"),
        ] {
            engine.read(&path, &["config", key, value]).unwrap();
        }
        Self { path, engine }
    }
    fn write(&self, file: &str, text: &str) {
        fs::write(self.path.join(file), text).unwrap();
    }
    fn commit(&self, message: &str) -> String {
        self.engine.read(&self.path, &["add", "--all"]).unwrap();
        self.engine
            .read(&self.path, &["commit", "-m", message])
            .unwrap();
        self.engine
            .read(&self.path, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .into()
    }
    fn run(&self, request: GitAction) -> ActionResult {
        self.engine.action(&self.path, request).unwrap()
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn unborn_repository_and_unicode_path() {
    let repo = Repo::new();
    repo.write("新增 文件.txt", "hello\n");
    let state = repo.engine.snapshot(&repo.path).unwrap();
    assert_eq!(state.branch, "main");
    assert_eq!(state.total, 0);
    assert!(state.commits.is_empty());
    assert_eq!(state.unstaged[0].path, "新增 文件.txt");
    assert_eq!(state.unstaged[0].status, "?");
    assert_eq!(
        repo.engine
            .repository(&path_string(&repo.path).unwrap())
            .unwrap(),
        fs::canonicalize(&repo.path).unwrap()
    );
}

#[test]
fn stage_and_unstage_unborn_preserve_file() {
    let repo = Repo::new();
    repo.write("hello.txt", "hello\n");
    assert_eq!(
        repo.run(GitAction::Stage {
            paths: vec!["hello.txt".into()]
        })
        .snapshot
        .staged[0]
            .status,
        "A"
    );
    let state = repo
        .run(GitAction::Unstage {
            paths: vec!["hello.txt".into()],
        })
        .snapshot;
    assert!(state.staged.is_empty());
    assert_eq!(
        fs::read_to_string(repo.path.join("hello.txt")).unwrap(),
        "hello\n"
    );
}

#[test]
fn commits_only_staged_files_with_unicode_message() {
    let repo = Repo::new();
    repo.write("one.txt", "one\n");
    repo.write("two.txt", "two\n");
    repo.run(GitAction::Stage {
        paths: vec!["one.txt".into()],
    });
    let state = repo
        .run(GitAction::Commit {
            message: "feat: 中文提交\n\n详细说明".into(),
        })
        .snapshot;
    assert_eq!(state.commits[0].subject, "feat: 中文提交");
    assert_eq!(state.unstaged[0].path, "two.txt");
    let detail = repo.engine.commit_details(&repo.path, &state.head).unwrap();
    assert_eq!(detail.files[0].path, "one.txt");
    assert_eq!(detail.files[0].status, "A");
    assert!(detail.body.contains("详细说明"));
}

#[test]
fn staged_and_working_diffs_remain_distinct() {
    let repo = Repo::new();
    repo.write("a.txt", "original\n");
    repo.commit("initial");
    repo.write("a.txt", "staged\n");
    repo.run(GitAction::Stage {
        paths: vec!["a.txt".into()],
    });
    repo.write("a.txt", "working\n");
    assert!(repo
        .engine
        .diff(&repo.path, "a.txt", true, None)
        .unwrap()
        .diff
        .contains("+staged"));
    assert!(repo
        .engine
        .diff(&repo.path, "a.txt", false, None)
        .unwrap()
        .diff
        .contains("+working"));
    let (staged, unstaged) = repo.engine.status(&repo.path).unwrap();
    assert_eq!((staged.len(), unstaged.len()), (1, 1));
}

#[test]
fn untracked_text_and_binary_diffs() {
    let repo = Repo::new();
    repo.write("new.txt", "你好\n");
    assert!(repo
        .engine
        .diff(&repo.path, "new.txt", false, None)
        .unwrap()
        .diff
        .contains("+你好"));
    fs::write(repo.path.join("binary.bin"), [0, 1, 255]).unwrap();
    assert!(repo
        .engine
        .diff(&repo.path, "binary.bin", false, None)
        .unwrap()
        .diff
        .contains("Binary files"));
}

#[test]
fn parses_undecorated_history_and_real_parents() {
    let repo = Repo::new();
    repo.write("a.txt", "one\n");
    let first = repo.commit("one");
    repo.write("a.txt", "two\n");
    let second = repo.commit("two");
    repo.write("a.txt", "three\n");
    let third = repo.commit("three");
    let state = repo.engine.snapshot(&repo.path).unwrap();
    assert_eq!(
        state
            .commits
            .iter()
            .map(|c| c.hash.as_str())
            .collect::<Vec<_>>(),
        vec![third.as_str(), second.as_str(), first.as_str()]
    );
    assert!(state.commits[1].refs.is_empty());
    assert_eq!(state.commits[1].parents, vec![first]);
}

#[test]
fn branches_merge_and_first_parent_diff() {
    let repo = Repo::new();
    repo.write("base.txt", "base\n");
    repo.commit("initial");
    repo.run(GitAction::Branch {
        name: "feature/demo".into(),
    });
    repo.write("feature.txt", "feature\n");
    let feature = repo.commit("feature");
    repo.run(GitAction::Checkout {
        name: "main".into(),
    });
    repo.write("main.txt", "main\n");
    let main = repo.commit("main update");
    repo.engine
        .read(
            &repo.path,
            &["merge", "--no-ff", "feature/demo", "-m", "merge"],
        )
        .unwrap();
    let state = repo.engine.snapshot(&repo.path).unwrap();
    assert_eq!(state.commits[0].parents, vec![main, feature]);
    assert_eq!(state.total, 4);
    let detail = repo.engine.commit_details(&repo.path, &state.head).unwrap();
    assert_eq!(detail.files.len(), 1);
    assert_eq!(detail.files[0].path, "feature.txt");
}

#[test]
fn checkout_refuses_overwriting_work() {
    let repo = Repo::new();
    repo.write("a.txt", "base\n");
    repo.commit("initial");
    repo.run(GitAction::Branch {
        name: "feature/demo".into(),
    });
    repo.write("a.txt", "feature\n");
    repo.commit("feature");
    repo.run(GitAction::Checkout {
        name: "main".into(),
    });
    repo.write("a.txt", "unsaved\n");
    assert!(repo
        .engine
        .action(
            &repo.path,
            GitAction::Checkout {
                name: "feature/demo".into()
            }
        )
        .is_err());
    assert_eq!(
        fs::read_to_string(repo.path.join("a.txt")).unwrap(),
        "unsaved\n"
    );
}

#[test]
fn detached_head_remains_visible() {
    let repo = Repo::new();
    repo.write("a.txt", "one\n");
    let head = repo.commit("one");
    repo.engine
        .read(&repo.path, &["checkout", "--detach", &head])
        .unwrap();
    repo.write("a.txt", "two\n");
    let detached = repo.commit("detached");
    let state = repo.engine.snapshot(&repo.path).unwrap();
    assert_eq!(state.branch, "detached HEAD");
    assert_eq!(state.commits[0].hash, detached);
}

#[test]
fn rename_unstage_restores_both_paths() {
    let repo = Repo::new();
    repo.write("before.txt", "same\n");
    repo.commit("initial");
    repo.engine
        .read(&repo.path, &["mv", "before.txt", "after.txt"])
        .unwrap();
    let staged = repo.engine.status(&repo.path).unwrap().0;
    assert_eq!(staged[0].old_path.as_deref(), Some("before.txt"));
    assert!(repo
        .run(GitAction::Unstage {
            paths: vec!["after.txt".into()]
        })
        .snapshot
        .staged
        .is_empty());
    assert!(repo.path.join("after.txt").exists());
}

#[test]
fn paths_are_literal_and_stale_actions_fail() {
    let repo = Repo::new();
    repo.write("[abc].txt", "literal\n");
    repo.write("a.txt", "other\n");
    let result = repo.run(GitAction::Stage {
        paths: vec!["[abc].txt".into()],
    });
    assert_eq!(result.snapshot.staged.len(), 1);
    assert_eq!(result.snapshot.staged[0].path, "[abc].txt");
    assert_eq!(result.snapshot.unstaged.len(), 1);
    assert!(repo
        .engine
        .action(
            &repo.path,
            GitAction::Stage {
                paths: vec!["not-a-change".into()]
            }
        )
        .is_err());
    assert!(repo
        .engine
        .action(
            &repo.path,
            GitAction::Stage {
                paths: vec!["../outside".into()]
            }
        )
        .is_err());
    assert!(repo
        .engine
        .action(
            &repo.path,
            GitAction::Branch {
                name: "--orphan".into()
            }
        )
        .is_err());
    assert!(repo
        .engine
        .action(&repo.path, GitAction::Commit { message: "".into() })
        .is_err());
}

#[test]
fn diff_truncation_keeps_utf8_boundaries() {
    let repo = Repo::new();
    repo.write("large.txt", &"字".repeat(MAX_DIFF + 100));
    let diff = repo
        .engine
        .diff(&repo.path, "large.txt", false, None)
        .unwrap();
    assert!(diff.truncated);
    assert_eq!(diff.diff.chars().count(), MAX_DIFF);
}

#[test]
fn initializes_new_directory_and_rejects_existing_paths() {
    let repo = Repo::new();
    let target = repo.path.join("new-project");
    let state = repo
        .engine
        .create(CreateRequest {
            kind: "init".into(),
            path: path_string(&target).unwrap(),
            url: String::new(),
        })
        .unwrap()
        .snapshot;
    assert_eq!(state.branch, "main");
    assert_eq!(state.total, 0);
    assert!(target.join(".git").is_dir());
    assert!(repo
        .engine
        .create(CreateRequest {
            kind: "init".into(),
            path: path_string(&repo.path).unwrap(),
            url: String::new()
        })
        .is_err());
}

#[test]
fn clones_local_repository_and_preserves_remote_refs() {
    let repo = Repo::new();
    repo.write("a.txt", "base\n");
    let head = repo.commit("initial");
    let target = repo.path.join("clone");
    let state = repo
        .engine
        .create(CreateRequest {
            kind: "clone".into(),
            path: path_string(&target).unwrap(),
            url: path_string(&repo.path).unwrap(),
        })
        .unwrap()
        .snapshot;
    assert_eq!(state.head, head);
    assert!(state.branches.iter().any(|branch| branch.kind == "remote"));
}

#[test]
fn local_remote_fetch_pull_push() {
    let repo = Repo::new();
    repo.write("a.txt", "base\n");
    repo.commit("initial");
    let remote = repo.path.join("remote.git");
    repo.engine
        .read(
            &repo.path,
            &["init", "--bare", &path_string(&remote).unwrap()],
        )
        .unwrap();
    repo.engine
        .read(
            &repo.path,
            &["remote", "add", "origin", &path_string(&remote).unwrap()],
        )
        .unwrap();
    repo.engine
        .read(&repo.path, &["push", "--set-upstream", "origin", "main"])
        .unwrap();
    repo.run(GitAction::Fetch);
    repo.run(GitAction::Pull);
    repo.write("a.txt", "next\n");
    let head = repo.commit("next");
    repo.run(GitAction::Push);
    assert_eq!(
        repo.engine
            .read(&remote, &["rev-parse", "main"])
            .unwrap()
            .trim(),
        head
    );
}

#[test]
fn validates_revisions_paths_remotes_and_request_shapes() {
    for value in ["", "HEAD", "HEAD;echo unsafe", &"f".repeat(41)] {
        assert!(validate_revision(value).is_err());
    }
    assert!(validate_revision(&"a".repeat(40)).is_ok());
    assert!(validate_revision(&"a".repeat(64)).is_ok());
    for value in ["", "../escape", "/absolute", "file\0name"] {
        assert!(validate_file(value).is_err());
    }
    for value in [
        "ext::sh -c unsafe",
        "--upload-pack=unsafe",
        "",
        "ftp://example.com/repo",
    ] {
        assert!(!valid_remote(value));
    }
    assert!(valid_remote("git@github.com:owner/repo.git"));
    assert!(valid_remote("https://example.com/repo.git"));
    assert!(serde_json::from_str::<GitAction>(r#"{"action":"reset"}"#).is_err());
    assert!(
        serde_json::from_str::<GitAction>(r#"{"action":"stage","paths":["a"],"extra":"x"}"#)
            .is_err()
    );
}

#[test]
fn cancellation_is_detected_before_starting_git() {
    let repo = Repo::new();
    repo.engine.cancel.store(true, Ordering::Release);
    let error = repo.engine.snapshot(&repo.path).unwrap_err();
    assert!(error.contains("取消"));
}

#[test]
fn status_parser_keeps_rename_and_conflict_records() {
    let (staged, unstaged) =
        parse_status("R  after.txt\0before.txt\0UU 冲突.txt\0?? new.txt\0MM both.txt\0").unwrap();
    assert_eq!(staged.len(), 2);
    assert_eq!(unstaged.len(), 3);
    assert_eq!(staged[0].old_path.as_deref(), Some("before.txt"));
    assert_eq!(unstaged[0].status, "U");
}

#[cfg(windows)]
#[test]
fn windows_rejects_wsl_and_drive_relative_file_paths() {
    assert!(absolute_path(r"\\wsl.localhost\Ubuntu\home\name\repo").is_err());
    assert!(absolute_path(r"\\wsl$\Ubuntu\home\name\repo").is_err());
    assert!(absolute_path(r"\\?\UNC\wsl.localhost\Ubuntu\home\name\repo").is_err());
    assert!(validate_file(r"C:\outside.txt").is_err());
    assert!(validate_file(r"C:relative.txt").is_err());
}

#[cfg(unix)]
#[test]
fn cancelling_an_active_process_terminates_it() {
    let cancel = Arc::new(AtomicBool::new(false));
    let other = cancel.clone();
    let started = Instant::now();
    let task = thread::spawn(move || {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 & wait"]);
        execute(command, Duration::from_secs(35), &other)
    });
    thread::sleep(Duration::from_millis(100));
    cancel.store(true, Ordering::Release);
    assert!(task.join().unwrap().unwrap_err().contains("取消"));
    assert!(started.elapsed() < Duration::from_secs(5));
}
