use crate::git::{
    ActionResult, CommitDetails, CreateRequest, CreateResult, DiffResult, GitAction, GitEngine,
    RuntimeInfo, Snapshot,
};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct DesktopState {
    engine: Arc<Mutex<GitEngine>>,
    cancel: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    closing: Arc<AtomicBool>,
}

impl Default for DesktopState {
    fn default() -> Self {
        let engine = GitEngine::discover();
        Self {
            cancel: engine.cancel.clone(),
            engine: Arc::new(Mutex::new(engine)),
            generation: Arc::new(AtomicU64::new(0)),
            closing: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl DesktopState {
    pub fn begin_shutdown(&self) -> Option<Arc<Mutex<GitEngine>>> {
        if self.closing.swap(true, Ordering::AcqRel) {
            return None;
        }
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.cancel.store(true, Ordering::Release);
        Some(self.engine.clone())
    }
}

async fn job<T: Send + 'static>(
    state: &DesktopState,
    work: impl FnOnce(&GitEngine) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let engine = state.engine.clone();
    let generation = state.generation.clone();
    let queued_at = generation.load(Ordering::Acquire);
    let closing = state.closing.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Serializes Git work without blocking the UI or async executor.
        let engine = engine
            .lock()
            .map_err(|_| "Git 服务异常，请重启应用。".to_string())?;
        if closing.load(Ordering::Acquire) {
            return Err("应用正在退出，Git 操作已取消。".into());
        }
        engine.cancel.store(false, Ordering::Release);
        if generation.load(Ordering::Acquire) != queued_at {
            return Err("排队的 Git 操作已取消。".into());
        }
        work(&engine)
    })
    .await
    .map_err(|e| format!("Git 任务异常：{e}"))?
}

#[tauri::command]
pub async fn runtime_info(state: State<'_, DesktopState>) -> Result<RuntimeInfo, String> {
    job(&state, |engine| Ok(engine.runtime())).await
}

#[tauri::command]
pub async fn repository_snapshot(
    repo: String,
    state: State<'_, DesktopState>,
) -> Result<Snapshot, String> {
    job(&state, move |engine| {
        engine.snapshot(&engine.repository(&repo)?)
    })
    .await
}

#[tauri::command]
pub async fn commit_details(
    repo: String,
    commit: String,
    state: State<'_, DesktopState>,
) -> Result<CommitDetails, String> {
    job(&state, move |engine| {
        engine.commit_details(&engine.repository(&repo)?, &commit)
    })
    .await
}

#[tauri::command]
pub async fn file_diff(
    repo: String,
    path: String,
    staged: bool,
    commit: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<DiffResult, String> {
    job(&state, move |engine| {
        engine.diff(&engine.repository(&repo)?, &path, staged, commit.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_action(
    repo: String,
    request: GitAction,
    state: State<'_, DesktopState>,
) -> Result<ActionResult, String> {
    job(&state, move |engine| {
        engine.action(&engine.repository(&repo)?, request)
    })
    .await
}

#[tauri::command]
pub async fn create_repository(
    request: CreateRequest,
    state: State<'_, DesktopState>,
) -> Result<CreateResult, String> {
    job(&state, move |engine| engine.create(request)).await
}

#[tauri::command]
pub fn cancel_git_operation(state: State<'_, DesktopState>) {
    state.generation.fetch_add(1, Ordering::AcqRel);
    state.cancel.store(true, Ordering::Release);
}

#[tauri::command]
pub async fn choose_directory(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择仓库或父目录")
            .blocking_pick_folder()
            .map(|file| {
                file.into_path()
                    .map_err(|e| format!("无法解析目录：{e}"))
                    .and_then(|path| {
                        path.to_str()
                            .map(String::from)
                            .ok_or_else(|| "目录无法用 Unicode 表示。".to_string())
                    })
            })
            .transpose()
    })
    .await
    .map_err(|e| format!("目录选择失败：{e}"))?
}

#[tauri::command]
pub fn open_resource(resource: String, app: AppHandle) -> Result<(), String> {
    let url = match resource.as_str() {
        "git-docs" => "https://git-scm.com/docs",
        "git-book" => "https://git-scm.com/book/zh/v2",
        _ => return Err("未知的帮助资源。".into()),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("无法打开浏览器：{e}"))
}
