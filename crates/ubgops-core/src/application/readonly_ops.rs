use crate::application::{MAX_CONCURRENT_READONLY_OPENS, ReadOnlyOpenKey};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio_util::sync::CancellationToken;
use ubgops_model::{AppError, ErrorCode, HostId, HostSessionId};

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
    pub peak_supervised_tasks: usize,
    pub peak_registered_requests: usize,
    pub confirmed_cleanups: u64,
    pub retired_channel_unknown_settlements: u64,
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

    pub fn is_shutdown(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .shutdown
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
