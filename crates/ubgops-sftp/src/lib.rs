mod client;
mod editor;
mod path;
mod policy;
mod transfer;

pub use client::{
    EditorRevision, EntryIdentity, LISTING_ENTRY_CAP, Progress, RawSftpClient, ReadOnlyFileBytes,
    SftpClient, StagedUploadFailure, StagedUploadResult, StagingCleanup, StagingOwnership,
};
pub use editor::{decode_text, encode_text};
pub use path::{
    display_name, join_remote, parent_remote, validate_child_name, validate_remote_path,
    validate_windows_file_name,
};
pub use policy::{
    DestinationAction, FilePlanStore, InternalPlan, LocalDirectory, LocalIdentity, LocalItem,
    LocalObjectId, MutationSpec, PlanPayload, PlannedDownload, PlannedUpload, RemoteSource,
    open_local_directory, open_local_source, validate_local_directory,
    validate_local_directory_handle,
};
pub use transfer::TransferManager;

use async_trait::async_trait;
use std::sync::Arc;
use ubgops_model::{AppError, HostId, HostSessionId};

#[async_trait]
pub trait SftpConnector: Send + Sync {
    async fn open_sftp(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
    ) -> Result<Arc<dyn SftpClient>, AppError>;
}
