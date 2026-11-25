use super::*;
use std::sync::Arc;
use ubgops_sftp::{LocalDirectory, LocalItem, MutationSpec, SftpClient};

impl Application {
    pub async fn open_sftp(&self, host_id: HostId) -> Result<SftpSessionInfo, AppError> {
        self.repository.get(host_id)?;
        let startup = self.sftp_lifecycle_gate(host_id).await;
        let _startup_guard = startup.lock().await;
        let slot = self.slot(host_id).await;
        let (transport, connection_id, generation) = {
            let data = slot.data.lock().await;
            if data.view.state != ConnectionState::Connected {
                return Err(AppError::new(
                    ErrorCode::SftpUnavailable,
                    "Connect this host before opening Files.",
                ));
            }
            (
                data.transport.clone().ok_or_else(|| {
                    AppError::new(ErrorCode::Connection, "The SSH session is unavailable.")
                })?,
                data.connection_id.ok_or_else(|| {
                    AppError::new(
                        ErrorCode::Connection,
                        "The SSH session identity is unavailable.",
                    )
                })?,
                data.generation,
            )
        };
        if let Some(existing) = self.sftp_sessions.lock().await.get(&host_id).cloned()
            && existing.info().host_session_id == connection_id
        {
            return Ok(existing.info());
        }
        let client = transport.open_sftp(host_id, connection_id).await?;
        let data = slot.data.lock().await;
        if data.generation != generation
            || data.connection_id != Some(connection_id)
            || data.view.state != ConnectionState::Connected
        {
            drop(data);
            client.close().await;
            return Err(cancelled());
        }
        drop(data);
        let old = self
            .sftp_sessions
            .lock()
            .await
            .insert(host_id, client.clone());
        if let Some(old) = old {
            old.close().await;
        }
        Ok(client.info())
    }

    pub async fn list_remote_directory(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        path: String,
    ) -> Result<DirectoryListing, AppError> {
        self.owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?
            .list(&path, CancellationToken::new())
            .await
    }

    pub async fn remote_properties(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        path: String,
    ) -> Result<RemoteEntry, AppError> {
        self.owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?
            .stat(&path)
            .await
    }

    pub async fn open_remote_text_file(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        path: String,
    ) -> Result<ubgops_model::RemoteTextDocument, AppError> {
        let gate = self.sftp_lifecycle_gate(host_id).await;
        let _guard = gate.lock().await;
        let client = self
            .owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        let before = client.editor_revision(&path).await?;
        let bytes = client.read_editor_bytes(&path).await?;
        let after = client.editor_revision(&path).await?;
        if before != after || before.identity.size != Some(bytes.len() as u64) {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "The remote text file changed while opening.",
            ));
        }
        let (text, newline, bom) = ubgops_sftp::decode_text(&bytes)?;
        let id = self.file_plans.register_editor_document(
            client.as_ref(),
            path.clone(),
            before,
            &bytes,
            newline,
            bom,
        )?;
        Ok(ubgops_model::RemoteTextDocument {
            id,
            host_id,
            host_session_id,
            sftp_session_id,
            path,
            text,
            original_bytes: bytes.len() as u32,
            newline,
            bom,
            max_bytes: ubgops_model::MAX_REMOTE_EDITOR_BYTES as u32,
        })
    }

    pub async fn open_remote_readonly_document(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        request_id: ReadOnlyDocumentId,
        path: String,
    ) -> Result<RemoteReadOnlyDocument, AppError> {
        let client = self
            .owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        let cancel = CancellationToken::new();
        let key = (host_id, host_session_id, sftp_session_id, request_id);
        {
            let mut opens = self.read_only_opens.lock().await;
            if opens.contains_key(&key) {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "A read-only open with this request identity is already in progress.",
                ));
            }
            opens.insert(key, cancel.clone());
        }
        struct ReadOnlyOpenCleanup<'a> {
            opens: &'a crate::application::ReadOnlyOpenMap,
            key: crate::application::ReadOnlyOpenKey,
        }
        impl Drop for ReadOnlyOpenCleanup<'_> {
            fn drop(&mut self) {
                if let Ok(mut opens) = self.opens.try_lock() {
                    opens.remove(&self.key);
                } else if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                    let _ = runtime;
                }
            }
        }
        let _cleanup = ReadOnlyOpenCleanup {
            opens: &self.read_only_opens,
            key,
        };

        let result = async {
            let _permit = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    return Err(AppError::new(
                        ErrorCode::Cancelled,
                        "Read-only file loading was cancelled.",
                    ));
                }
                permit = self.read_only_open_limit.acquire() => permit.map_err(|_| {
                    AppError::new(ErrorCode::Cancelled, "Read-only file loading was closed.")
                })?,
            };
            let raw = client.read_only_file_bytes(&path, cancel.clone()).await?;
            let (text, newline, bom) = ubgops_sftp::decode_text(&raw.bytes)?;
            self.owned_sftp(host_id, host_session_id, sftp_session_id)
                .await?;
            if cancel.is_cancelled() {
                return Err(AppError::new(
                    ErrorCode::Cancelled,
                    "Read-only file loading was cancelled.",
                ));
            }
            Ok(RemoteReadOnlyDocument {
                id: ReadOnlyDocumentId::new(),
                host_id,
                host_session_id,
                sftp_session_id,
                display_name: ubgops_sftp::display_name(&path),
                path,
                text,
                original_bytes: raw.bytes.len() as u32,
                newline,
                bom,
                max_bytes: MAX_REMOTE_EDITOR_BYTES as u32,
                modified_at: raw.modified_at,
                permissions: raw.permissions,
            })
        }
        .await;
        self.read_only_opens.lock().await.remove(&key);
        result
    }

    pub async fn cancel_remote_readonly_open(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        request_id: ReadOnlyDocumentId,
    ) -> Result<bool, AppError> {
        let key = (host_id, host_session_id, sftp_session_id, request_id);
        let removed = self.read_only_opens.lock().await.remove(&key);
        if let Some(token) = removed {
            token.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn plan_remote_text_save(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        document_id: ubgops_model::EditorDocumentId,
        text: String,
    ) -> Result<FileOperationPlan, AppError> {
        let gate = self.sftp_lifecycle_gate(host_id).await;
        let _guard = gate.lock().await;
        let client = self
            .owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        self.file_plans
            .plan_editor_save(client, document_id, text)
            .await
    }

    pub fn discard_remote_text_document(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        document_id: ubgops_model::EditorDocumentId,
    ) -> Result<(), AppError> {
        self.file_plans.discard_editor_document(
            document_id,
            host_id,
            host_session_id,
            sftp_session_id,
        )
    }

    pub async fn plan_upload(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        sources: Vec<LocalItem>,
        remote_directory: String,
        policy: ConflictPolicy,
    ) -> Result<FileOperationPlan, AppError> {
        let startup = self.sftp_lifecycle_gate(host_id).await;
        let _startup_guard = startup.lock().await;
        let client = self
            .owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        self.file_plans
            .plan_upload(client, sources, &remote_directory, policy)
            .await
    }

    pub async fn plan_download(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        remote_paths: Vec<String>,
        local_directory: LocalDirectory,
        policy: ConflictPolicy,
    ) -> Result<FileOperationPlan, AppError> {
        let startup = self.sftp_lifecycle_gate(host_id).await;
        let _startup_guard = startup.lock().await;
        let client = self
            .owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        ubgops_sftp::validate_local_directory_handle(&local_directory)?;
        self.file_plans
            .plan_download(client, remote_paths, local_directory, policy)
            .await
    }

    pub async fn plan_create_directory(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        parent: String,
        name: String,
    ) -> Result<FileOperationPlan, AppError> {
        ubgops_sftp::validate_child_name(&name)?;
        let path = ubgops_sftp::join_remote(&parent, &name)?;
        let startup = self.sftp_lifecycle_gate(host_id).await;
        let _startup_guard = startup.lock().await;
        let client = self
            .owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        if client.identity(&path).await?.is_some() {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "The remote destination already exists.",
            ));
        }
        self.file_plans
            .plan_mutation(client, MutationSpec::CreateDirectory { path })
    }

    pub async fn plan_rename(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        source: String,
        new_name: String,
    ) -> Result<FileOperationPlan, AppError> {
        ubgops_sftp::validate_child_name(&new_name)?;
        let destination =
            ubgops_sftp::join_remote(&ubgops_sftp::parent_remote(&source)?, &new_name)?;
        let startup = self.sftp_lifecycle_gate(host_id).await;
        let _startup_guard = startup.lock().await;
        let client = self
            .owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        let identity = client.identity(&source).await?.ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "The remote source no longer exists.")
        })?;
        if identity.kind != RemoteEntryKind::File
            || !client.info().extensions.iter().any(|extension| {
                extension.name == "hardlink@openssh.com" && extension.version == "1"
            })
        {
            return Err(AppError::new(
                ErrorCode::SftpUnavailable,
                "Safe no-clobber rename is available only for regular files when hardlink@openssh.com v1 is negotiated.",
            ));
        }
        if client.identity(&destination).await?.is_some() {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "The remote destination already exists.",
            ));
        }
        self.file_plans.plan_mutation(
            client,
            MutationSpec::Rename {
                source,
                destination,
                expected_source: identity,
            },
        )
    }

    pub async fn plan_delete(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        path: String,
    ) -> Result<FileOperationPlan, AppError> {
        let startup = self.sftp_lifecycle_gate(host_id).await;
        let _startup_guard = startup.lock().await;
        let client = self
            .owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        let entry = client.stat(&path).await?;
        if matches!(
            entry.kind,
            RemoteEntryKind::Other | RemoteEntryKind::Unknown
        ) {
            return Err(AppError::new(
                ErrorCode::FilePolicy,
                "Special or unknown entries cannot be deleted.",
            ));
        }
        let expected = client.identity(&path).await?.ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "The remote entry no longer exists.")
        })?;
        self.file_plans.plan_mutation(
            client,
            MutationSpec::Delete {
                path,
                kind: entry.kind,
                expected,
            },
        )
    }

    pub async fn execute_file_plan(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        plan_id: FilePlanId,
    ) -> Result<Vec<TransferJob>, AppError> {
        let startup = self.sftp_lifecycle_gate(host_id).await;
        let _startup_guard = startup.lock().await;
        self.owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        let plan = self
            .file_plans
            .consume(plan_id, host_id, host_session_id, sftp_session_id)?;
        let audit_kind = match plan.view.kind {
            FileOperationKind::EditText => "file.editor_save.accepted",
            FileOperationKind::CreateDirectory => "file.create_directory",
            FileOperationKind::Rename => "file.rename",
            FileOperationKind::Delete => "file.delete",
            _ => "file.transfer.accepted",
        };
        let started = Instant::now();
        let result = self.transfers.execute(plan).await;
        self.record(
            host_id,
            audit_kind,
            if result.is_ok() {
                AuditOutcome::Success
            } else {
                AuditOutcome::Failed
            },
            started,
        )?;
        result
    }

    pub async fn discard_file_plan(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        plan_id: FilePlanId,
    ) -> Result<bool, AppError> {
        self.file_plans
            .discard(plan_id, host_id, host_session_id, sftp_session_id)
    }

    pub fn list_transfers(&self, host_id: Option<HostId>) -> Vec<TransferJob> {
        self.transfers.list(host_id)
    }
    pub async fn cancel_transfer(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        job_id: TransferJobId,
    ) -> Result<(), AppError> {
        self.owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        self.transfers
            .cancel(job_id, host_id, host_session_id, sftp_session_id)
    }
    pub async fn plan_retry_transfer(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
        job_id: TransferJobId,
    ) -> Result<FileOperationPlan, AppError> {
        self.owned_sftp(host_id, host_session_id, sftp_session_id)
            .await?;
        self.transfers
            .retry_plan(
                &self.file_plans,
                job_id,
                host_id,
                host_session_id,
                sftp_session_id,
            )
            .await
    }

    pub(crate) async fn close_sftp(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
    ) -> Result<(), AppError> {
        let startup = self.sftp_lifecycle_gate(host_id).await;
        let _startup_guard = startup.lock().await;
        {
            let mut opens = self.read_only_opens.lock().await;
            opens.retain(|(open_host, open_session, _, _), cancel| {
                if *open_host == host_id && *open_session == host_session_id {
                    cancel.cancel();
                    false
                } else {
                    true
                }
            });
        }
        self.file_plans.revoke_session(host_id, host_session_id);
        self.transfers
            .quiesce_session(host_id, host_session_id)
            .await?;
        let session = {
            let mut sessions = self.sftp_sessions.lock().await;
            match sessions.get(&host_id) {
                Some(value) if value.info().host_session_id == host_session_id => {
                    sessions.remove(&host_id)
                }
                _ => None,
            }
        };
        if let Some(session) = session {
            session.close().await;
        }
        Ok(())
    }

    pub async fn validate_sftp_session(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
    ) -> Result<(), AppError> {
        self.owned_sftp(host_id, host_session_id, sftp_session_id)
            .await
            .map(|_| ())
    }

    async fn sftp_lifecycle_gate(&self, host_id: HostId) -> Arc<tokio::sync::Mutex<()>> {
        self.sftp_startups
            .lock()
            .await
            .entry(host_id)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    async fn owned_sftp(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
        sftp_session_id: SftpSessionId,
    ) -> Result<Arc<dyn SftpClient>, AppError> {
        let slot = self.slot(host_id).await;
        let data = slot.data.lock().await;
        if data.view.state != ConnectionState::Connected
            || data.connection_id != Some(host_session_id)
        {
            return Err(AppError::new(
                ErrorCode::Connection,
                "This file operation belongs to an old SSH connection.",
            ));
        }
        drop(data);
        let client = self
            .sftp_sessions
            .lock()
            .await
            .get(&host_id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::SftpUnavailable,
                    "Open the Files workspace again to start SFTP.",
                )
            })?;
        if client.info().id != sftp_session_id || client.info().host_session_id != host_session_id {
            return Err(AppError::new(
                ErrorCode::Policy,
                "This file operation belongs to an old SFTP session.",
            ));
        }
        Ok(client)
    }
}
