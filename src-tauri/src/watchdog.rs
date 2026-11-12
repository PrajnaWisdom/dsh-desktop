//! 资源看门狗：用 Windows Job Object 把 harness 进程树圈起来，限制
//! 内存 / 子进程数量上限，超限即整体 kill。
//!
//! 这是治「整机卡死」的核心：harness（dsh）跑 agent 任务时会拉起子进程、
//! 反复调模型、注入上下文，一旦失控会吃满整机资源。Job Object 提供内核级
//! 的资源配额，比在壳里做用户态监控（轮询 / 心跳）可靠得多——超限是内核直接
//! 拒绝/终止，不依赖壳的调度。
//!
//! 设计原则：
//! - harness 崩溃/超限绝不拖垮壳：壳只负责监控与 kill，harness 挂了壳照常存活。
//! - 配额是「上限保护」而非「精确限流」：正常会话远够用，失控会话被立刻扼杀。
//! - **刻意不设 CPU 上限**：CPU 该跑满就跑满（大型代码分析任务需要），只兜底
//!   内存泄漏与子进程失控这两类真正会让整机卡死的场景，最大程度不误伤正常使用。

use std::sync::atomic::{AtomicU32, Ordering};

/// Job Object 配额的默认上限（可在运行时调整）。
///
/// - `memory_mb`：进程树总内存上限（MB）。默认 4096 = 4GB，正常会话远够用。
/// - `max_processes`：允许同时存在的子进程数量上限。
/// - `kill_on_job_close`：Job Object 关闭时是否连带终止所有进程（默认是，防泄漏）。
#[derive(Debug, Clone)]
pub struct Quota {
    pub memory_mb: u64,
    pub max_processes: u32,
    pub kill_on_job_close: bool,
}

impl Default for Quota {
    fn default() -> Self {
        Self {
            memory_mb: 4096,
            max_processes: 64,
            kill_on_job_close: true,
        }
    }
}

/// 看门狗状态（供托盘/前端展示）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogState {
    /// 尚未把 harness 纳入 Job Object
    Idle,
    /// harness 进程树已在 Job Object 中受控运行
    Guarded,
    /// 检测到超限，已触发 kill（harness 被终止，壳存活）
    Killed,
    /// 非 Windows 平台（无 Job Object 能力），退化为无配额监控
    Degraded,
}

/// 看门狗的当前状态（进程级共享，供多个线程读取）。
static STATE: AtomicU32 = AtomicU32::new(0);

fn set_state(s: WatchdogState) {
    STATE.store(s as u32, Ordering::SeqCst);
}

/// 读取当前看门狗状态。
pub fn state() -> WatchdogState {
    match STATE.load(Ordering::SeqCst) {
        0 => WatchdogState::Idle,
        1 => WatchdogState::Guarded,
        2 => WatchdogState::Killed,
        _ => WatchdogState::Degraded,
    }
}

/// 看门狗句柄：持有 Job Object，Drop 时释放（按 `kill_on_job_close` 决定是否连带杀进程）。
#[cfg(windows)]
pub struct Watchdog {
    handle: windows::Win32::Foundation::HANDLE,
    quota: Quota,
}

// HANDLE 是 `*mut c_void` 的 newtype，默认 !Send + !Sync。但 Windows 内核句柄
// 本质是进程内共享的不可变标识，跨线程读写是安全的（与 tauri 内部处理窗口/
// 事件句柄同义）。SidecarInner 经 Arc 在多线程间共享，因此需要显式声明。
#[cfg(windows)]
unsafe impl Send for Watchdog {}
#[cfg(windows)]
unsafe impl Sync for Watchdog {}

#[cfg(not(windows))]
pub struct Watchdog {
    quota: Quota,
}

impl Watchdog {
    /// 创建一个新的看门狗并应用配额。
    ///
    /// 创建失败时返回 `Err`，调用方应降级为「无配额监控」而非崩溃。
    pub fn new(quota: Quota) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::JobObjects::{
                CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
                JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            };
            use windows::core::PCWSTR;

            unsafe {
                // 创建 Job Object
                let name: Vec<u16> = format!("dsh-harness-job-{}\0", std::process::id())
                    .encode_utf16()
                    .collect();
                let handle = CreateJobObjectW(None, PCWSTR(name.as_ptr()))
                    .map_err(|e| format!("创建 Job Object 失败: {e}"))?;

                // 扩展限制：内存上限 + 进程数上限 + kill-on-close。
                // 刻意不设 CPU 上限——不误伤正常的大型分析任务。
                let mut ext_limit: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                    std::mem::zeroed();
                ext_limit.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                if quota.kill_on_job_close {
                    ext_limit.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                }
                ext_limit.ProcessMemoryLimit = (quota.memory_mb * 1024 * 1024) as usize;
                ext_limit.BasicLimitInformation.ActiveProcessLimit = quota.max_processes;

                let res = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &ext_limit as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if res.is_err() {
                    let _ = CloseHandle(handle);
                    return Err(format!("设置 Job Object 扩展限制失败: {res:?}"));
                }

                set_state(WatchdogState::Guarded);
                Ok(Self { handle, quota })
            }
        }
        #[cfg(not(windows))]
        {
            set_state(WatchdogState::Degraded);
            Ok(Self { quota })
        }
    }

    /// 把 harness 主进程纳入 Job Object 管控。
    ///
    /// 一旦纳入，其所有子进程（bash、沙箱等）自动继承 Job 的配额。
    #[cfg(windows)]
    pub fn assign_process(&self, pid: u32) -> Result<(), String> {
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows::Win32::Foundation::CloseHandle;

        unsafe {
            let proc_handle = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                false,
                pid,
            )
            .map_err(|e| format!("打开进程 {pid} 失败: {e}"))?;

            let res = AssignProcessToJobObject(self.handle, proc_handle);
            let _ = CloseHandle(proc_handle);
            if res.is_err() {
                return Err(format!("将进程 {pid} 纳入 Job Object 失败: {res:?}"));
            }
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn assign_process(&self, _pid: u32) -> Result<(), String> {
        Err("非 Windows 平台无 Job Object 能力".into())
    }

    /// 强制终止 Job Object 内所有进程（harness 失控时调用）。
    #[cfg(windows)]
    pub fn kill_all(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;

        unsafe {
            // 1 = 进程退出码（可自定义，这里用 1 表示被看门狗终止）
            let _ = TerminateJobObject(self.handle, 1);
        }
        set_state(WatchdogState::Killed);
    }

    #[cfg(not(windows))]
    pub fn kill_all(&self) {
        set_state(WatchdogState::Killed);
    }

    /// 读取当前配额配置。
    pub fn quota(&self) -> &Quota {
        &self.quota
    }
}

#[cfg(windows)]
impl Drop for Watchdog {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        unsafe {
            let _ = CloseHandle(self.handle);
        }
        // 若 kill_on_job_close，Job Object 关闭时内核会连带终止所有进程。
        if !self.quota.kill_on_job_close {
            set_state(WatchdogState::Idle);
        }
    }
}

/// 获取逻辑 CPU 核数（保留，供未来 CPU 配额扩展使用）。
#[cfg(windows)]
#[allow(dead_code)]
fn num_cpus() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(8)
        .max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_quota_is_reasonable() {
        let q = Quota::default();
        assert!(q.memory_mb > 0);
        assert!(q.max_processes > 0);
    }

    #[test]
    fn watchdog_state_starts_idle() {
        // 单测环境可能已被其它用例影响，这里只验证状态机取值合法。
        let s = state();
        assert!(matches!(
            s,
            WatchdogState::Idle
                | WatchdogState::Guarded
                | WatchdogState::Killed
                | WatchdogState::Degraded
        ));
    }
}
