use async_trait::async_trait;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use ubgops_model::{AppError, Host};
use ubgops_operations::RemoteSession;
use ubgops_remote_operations::{
    MutationTransport, SystemdReload, SystemdResetFailed, SystemdStart, SystemdTryRestart,
};
use ubgops_secrets::Credential;
use ubgops_sftp::SftpConnector;
use ubgops_terminal::TerminalConnector;

/// The application orchestration boundary for future Local, Serial or other providers.
/// Only SSH is registered in Goal 01; domain/UI code never references russh.
pub trait ConnectedTransport:
    RemoteSession
    + TerminalConnector
    + SftpConnector
    + MutationTransport<SystemdResetFailed>
    + MutationTransport<SystemdTryRestart>
    + MutationTransport<SystemdReload>
    + MutationTransport<SystemdStart>
{
}
impl<T> ConnectedTransport for T where
    T: RemoteSession
        + TerminalConnector
        + SftpConnector
        + MutationTransport<SystemdResetFailed>
        + MutationTransport<SystemdTryRestart>
        + MutationTransport<SystemdReload>
        + MutationTransport<SystemdStart>
        + ?Sized
{
}

#[async_trait]
pub trait ConnectionProvider: Send + Sync {
    async fn connect(
        &self,
        host: &Host,
        credential: Credential,
        cancel: CancellationToken,
    ) -> Result<Arc<dyn ConnectedTransport>, AppError>;
}
#[async_trait]
impl ConnectionProvider for ubgops_ssh::SshProvider {
    async fn connect(
        &self,
        host: &Host,
        credential: Credential,
        cancel: CancellationToken,
    ) -> Result<Arc<dyn ConnectedTransport>, AppError> {
        let session = ubgops_ssh::SshProvider::connect(self, host, credential, cancel).await?;
        Ok(session)
    }
}
