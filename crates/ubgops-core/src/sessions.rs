use crate::ConnectedTransport;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use ubgops_model::{HostId, HostSession, HostSessionId};

pub(crate) struct SessionSlot {
    pub data: Mutex<SessionData>,
}
pub(crate) struct SessionData {
    pub view: HostSession,
    pub generation: u64,
    pub cancel: CancellationToken,
    pub transport: Option<Arc<dyn ConnectedTransport>>,
    pub connection_id: Option<HostSessionId>,
    pub refreshing: bool,
}
impl SessionSlot {
    pub fn new(id: HostId) -> Self {
        Self {
            data: Mutex::new(SessionData {
                view: HostSession::disconnected(id),
                generation: 0,
                cancel: CancellationToken::new(),
                transport: None,
                connection_id: None,
                refreshing: false,
            }),
        }
    }
}
