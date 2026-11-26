use crate::application::{MAX_CONCURRENT_READONLY_OPENS, ReadOnlyOpenKey};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio_util::sync::CancellationToken;
use ubgops_model::{AppError, ErrorCode, HostId, HostSessionId, SftpSessionId};

pub(crate) const MAX_SEALED_SESSIONS: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadOnlyOpenMetrics {
    pub max_concurrent: usize,
    pub held_permits: usize,
    pub available_permits: usize,
    pub registered_requests: usize,
    pub live_supervised_tasks: usize,
    pub peak_supervised_tasks: usize,
    pub peak_registered_requests: usize,
    pub confirmed_cleanups: u64,
    pub retired_channel_unknown_settlements: u64,
}

#[derive(Clone)]
pub(crate) struct ActiveReadOnlyRegistration {
    pub op_id: u64,
    pub cancel: CancellationToken,
}

pub(crate) struct SupervisedReadOnlyOp {
    pub host_id: HostId,
    pub host_session_id: HostSessionId,
    pub cancel: CancellationToken,
    pub done: watch::Receiver<bool>,
}

#[derive(Default)]
pub(crate) struct ReadOnlySupervisorState {
    pub shutdown: bool,
    pub next_op_id: u64,
    pub active_by_key: HashMap<ReadOnlyOpenKey, ActiveReadOnlyRegistration>,
    pub supervised_ops: HashMap<u64, SupervisedReadOnlyOp>,
    pub sealed_sessions: HashSet<(HostId, HostSessionId)>,
    pub sealed_order: VecDeque<(HostId, HostSessionId)>,
    pub sealed_sftp_channels: HashSet<SftpSessionId>,
    pub sealed_sftp_order: VecDeque<SftpSessionId>,
    pub peak_supervised_tasks: usize,
    pub peak_registered_requests: usize,
    pub confirmed_cleanups: u64,
    pub retired_channel_unknown_settlements: u64,
    #[cfg(test)]
    pub before_register_barrier: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Barrier>)>,
}

impl ReadOnlySupervisorState {
    fn seal_session_locked(&mut self, session: (HostId, HostSessionId)) {
        if self.sealed_sessions.insert(session) {
            if self.sealed_order.len() >= MAX_SEALED_SESSIONS
                && let Some(evicted) = self.sealed_order.pop_front()
            {
                self.sealed_sessions.remove(&evicted);
            }
            self.sealed_order.push_back(session);
        }
    }

    fn seal_sftp_locked(&mut self, sftp_session_id: SftpSessionId) {
        if self.sealed_sftp_channels.insert(sftp_session_id) {
            if self.sealed_sftp_order.len() >= MAX_SEALED_SESSIONS
                && let Some(evicted) = self.sealed_sftp_order.pop_front()
            {
                self.sealed_sftp_channels.remove(&evicted);
            }
            self.sealed_sftp_order.push_back(sftp_session_id);
        }
    }
}

#[derive(Clone)]
pub(crate) struct ReadOnlyOpenSupervisor {
    limit: Arc<Semaphore>,
    state: Arc<Mutex<ReadOnlySupervisorState>>,
}

impl Default for ReadOnlyOpenSupervisor {
    fn default() -> Self {
        Self {
            limit: Arc::new(Semaphore::new(MAX_CONCURRENT_READONLY_OPENS)),
            state: Arc::new(Mutex::new(ReadOnlySupervisorState::default())),
        }
    }
}

impl ReadOnlyOpenSupervisor {
    pub fn state_arc(&self) -> Arc<Mutex<ReadOnlySupervisorState>> {
        Arc::clone(&self.state)
    }

    pub fn try_acquire_permit(&self) -> Result<OwnedSemaphorePermit, AppError> {
        Arc::clone(&self.limit).try_acquire_owned().map_err(|_| {
            AppError::new(
                ErrorCode::Conflict,
                "Too many read-only file loads are already in progress.",
            )
        })
    }

    pub fn ensure_admissible(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
    ) -> Result<(), AppError> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.shutdown {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "UBGOps is shutting down.",
            ));
        }
        if state.sealed_sessions.contains(&(host_id, host_session_id)) {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "The SSH connection for this file operation has disconnected.",
            ));
        }
        if state.sealed_sftp_channels.contains(&sftp_session_id) {
            return Err(AppError::new(
                ErrorCode::SftpUnavailable,
                "The SFTP channel was retired after an unresolved operation; reopen Files to start a fresh SFTP session.",
            ));
        }
        Ok(())
    }

    pub fn seal_sftp_channel(&self, sftp_session_id: SftpSessionId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.seal_sftp_locked(sftp_session_id);
    }

    /// Registers a newly admitted supervised read-only operation. The returned `op_id`
    /// identifies this exact execution instance so overlapping cancellation or drop guards
    /// never remove a newer registration under a reused `request_id`.
    pub fn register(
        &self,
        key: ReadOnlyOpenKey,
        cancel: CancellationToken,
        done_rx: watch::Receiver<bool>,
    ) -> Result<u64, AppError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.shutdown {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "UBGOps is shutting down.",
            ));
        }
        if state.sealed_sessions.contains(&(key.0, key.1)) {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "The SSH connection for this file operation has disconnected.",
            ));
        }
        if state.sealed_sftp_channels.contains(&key.2) {
            return Err(AppError::new(
                ErrorCode::SftpUnavailable,
                "The SFTP channel was retired after an unresolved operation; reopen Files to start a fresh SFTP session.",
            ));
        }
        if state.active_by_key.contains_key(&key) {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "A read-only open with this request identity is already in progress.",
            ));
        }
        if state.active_by_key.len() >= MAX_CONCURRENT_READONLY_OPENS
            || state.supervised_ops.len() >= MAX_CONCURRENT_READONLY_OPENS
        {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "Too many read-only file loads are already in progress.",
            ));
        }
        state.next_op_id = state.next_op_id.wrapping_add(1).max(1);
        let op_id = state.next_op_id;
        state.active_by_key.insert(
            key,
            ActiveReadOnlyRegistration {
                op_id,
                cancel: cancel.clone(),
            },
        );
        state.supervised_ops.insert(
            op_id,
            SupervisedReadOnlyOp {
                host_id: key.0,
                host_session_id: key.1,
                cancel,
                done: done_rx,
            },
        );
        state.peak_registered_requests = state
            .peak_registered_requests
            .max(state.active_by_key.len());
        state.peak_supervised_tasks = state.peak_supervised_tasks.max(state.supervised_ops.len());
        Ok(op_id)
    }

    /// Cancels an active caller registration identified by the full host/session/request key.
    /// Removes the lookup registration immediately and signals the underlying supervised task;
    /// the admission permit remains held until the supervised task settles.
    pub fn cancel_by_key(&self, key: ReadOnlyOpenKey) -> bool {
        let removed = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active_by_key
            .remove(&key);
        if let Some(entry) = removed {
            entry.cancel.cancel();
            true
        } else {
            false
        }
    }

    pub fn cancel_session(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
    ) -> Vec<watch::Receiver<bool>> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.seal_session_locked((host_id, host_session_id));
        let active_keys = state
            .active_by_key
            .keys()
            .filter(|(h, s, _, _)| *h == host_id && *s == host_session_id)
            .copied()
            .collect::<Vec<_>>();
        for key in active_keys {
            if let Some(entry) = state.active_by_key.remove(&key) {
                entry.cancel.cancel();
            }
        }
        let mut receivers = Vec::new();
        for op in state.supervised_ops.values() {
            if op.host_id == host_id && op.host_session_id == host_session_id {
                op.cancel.cancel();
                receivers.push(op.done.clone());
            }
        }
        receivers
    }

    pub fn begin_shutdown(&self) -> Vec<watch::Receiver<bool>> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.shutdown = true;
        let drained = state
            .active_by_key
            .drain()
            .map(|(_, entry)| entry.cancel)
            .collect::<Vec<_>>();
        for cancel in drained {
            cancel.cancel();
        }
        let mut receivers = Vec::new();
        for op in state.supervised_ops.values() {
            op.cancel.cancel();
            receivers.push(op.done.clone());
        }
        receivers
    }

    pub async fn quiesce(
        receivers: Vec<watch::Receiver<bool>>,
        timeout: Duration,
    ) -> Result<(), AppError> {
        let deadline = tokio::time::Instant::now() + timeout;
        for mut done in receivers {
            if *done.borrow() {
                continue;
            }
            let wait = tokio::time::timeout_at(deadline, done.wait_for(|finished| *finished)).await;
            if !matches!(wait, Ok(Ok(_))) {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "Read-only SFTP cleanup did not finish within the shutdown timeout.",
                ));
            }
        }
        Ok(())
    }

    pub fn metrics(&self) -> ReadOnlyOpenMetrics {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let available_permits = self.limit.available_permits();
        ReadOnlyOpenMetrics {
            max_concurrent: MAX_CONCURRENT_READONLY_OPENS,
            held_permits: MAX_CONCURRENT_READONLY_OPENS.saturating_sub(available_permits),
            available_permits,
            registered_requests: state.active_by_key.len(),
            live_supervised_tasks: state.supervised_ops.len(),
            peak_supervised_tasks: state.peak_supervised_tasks,
            peak_registered_requests: state.peak_registered_requests,
            confirmed_cleanups: state.confirmed_cleanups,
            retired_channel_unknown_settlements: state.retired_channel_unknown_settlements,
        }
    }
    #[cfg(test)]
    pub fn set_before_register_barrier(
        &self,
        hook: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Barrier>)>,
    ) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.before_register_barrier = hook;
    }

    #[cfg(test)]
    pub async fn wait_before_register(&self) {
        let hook = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .before_register_barrier
            .clone();
        if let Some((entered, barrier)) = hook {
            entered.notify_one();
            barrier.wait().await;
        }
    }

    #[cfg(test)]
    pub fn is_session_sealed(&self, host_id: HostId, host_session_id: HostSessionId) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .sealed_sessions
            .contains(&(host_id, host_session_id))
    }

    #[cfg(test)]
    pub fn sealed_session_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .sealed_sessions
            .len()
    }
}

pub(crate) struct CallerDropGuard {
    state: Arc<Mutex<ReadOnlySupervisorState>>,
    key: ReadOnlyOpenKey,
    op_id: u64,
    cancel: CancellationToken,
    armed: bool,
}

impl CallerDropGuard {
    pub fn new(
        state: Arc<Mutex<ReadOnlySupervisorState>>,
        key: ReadOnlyOpenKey,
        op_id: u64,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            state,
            key,
            op_id,
            cancel,
            armed: true,
        }
    }

    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CallerDropGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.cancel.cancel();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state
            .active_by_key
            .get(&self.key)
            .is_some_and(|entry| entry.op_id == self.op_id)
        {
            state.active_by_key.remove(&self.key);
        }
    }
}

pub(crate) struct SupervisedTaskGuard {
    state: Arc<Mutex<ReadOnlySupervisorState>>,
    key: ReadOnlyOpenKey,
    op_id: u64,
    done_tx: watch::Sender<bool>,
    permit: Option<OwnedSemaphorePermit>,
}

impl SupervisedTaskGuard {
    pub fn new(
        state: Arc<Mutex<ReadOnlySupervisorState>>,
        key: ReadOnlyOpenKey,
        op_id: u64,
        done_tx: watch::Sender<bool>,
        permit: OwnedSemaphorePermit,
    ) -> Self {
        Self {
            state,
            key,
            op_id,
            done_tx,
            permit: Some(permit),
        }
    }
}

impl Drop for SupervisedTaskGuard {
    fn drop(&mut self) {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state
                .active_by_key
                .get(&self.key)
                .is_some_and(|entry| entry.op_id == self.op_id)
            {
                state.active_by_key.remove(&self.key);
            }
            state.supervised_ops.remove(&self.op_id);
        }
        drop(self.permit.take());
        let _ = self.done_tx.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ubgops_model::ReadOnlyDocumentId;

    #[tokio::test]
    async fn supervisor_cancel_session_seals_across_quiesce_and_bounds_fifo() {
        let supervisor = ReadOnlyOpenSupervisor::default();
        let host_id = HostId::new();
        let old_session = HostSessionId::new();
        let sftp_id = SftpSessionId::new();
        let req_id = ReadOnlyDocumentId::new();

        let receivers = supervisor.cancel_session(host_id, old_session);
        ReadOnlyOpenSupervisor::quiesce(receivers, Duration::from_millis(50))
            .await
            .unwrap();
        assert!(supervisor.is_session_sealed(host_id, old_session));

        let cancel = CancellationToken::new();
        let (_tx, rx) = watch::channel(false);
        let err = supervisor
            .register((host_id, old_session, sftp_id, req_id), cancel, rx)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Cancelled);

        // Idempotent repeat seal does not grow sealed FIFO unexpectedly, and exceeding
        // MAX_SEALED_SESSIONS evicts oldest entries cleanly without unbounded growth.
        for _ in 0..(MAX_SEALED_SESSIONS + 25) {
            let h = HostId::new();
            let s = HostSessionId::new();
            supervisor.cancel_session(h, s);
        }
        assert_eq!(supervisor.sealed_session_count(), MAX_SEALED_SESSIONS);
        assert!(!supervisor.is_session_sealed(host_id, old_session));
    }

    #[tokio::test]
    async fn supervisor_retired_sftp_channel_is_sealed() {
        let supervisor = ReadOnlyOpenSupervisor::default();
        let host_id = HostId::new();
        let session_id = HostSessionId::new();
        let sftp_id = SftpSessionId::new();
        let req_id = ReadOnlyDocumentId::new();

        supervisor.seal_sftp_channel(sftp_id);
        let cancel = CancellationToken::new();
        let (_tx, rx) = watch::channel(false);
        let err = supervisor
            .register((host_id, session_id, sftp_id, req_id), cancel, rx)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::SftpUnavailable);
    }
}
