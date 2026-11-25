use super::*;

impl Application {
    pub async fn sample_host_monitor(
        &self,
        host_id: HostId,
        host_session_id: HostSessionId,
    ) -> Result<HostMonitorSample, AppError> {
        self.repository.get(host_id)?;
        let gate = {
            let mut gates = self.monitor_gates.lock().await;
            gates
                .entry(host_id)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _sample = gate.lock().await;
        let slot = self.slot(host_id).await;
        let (transport, cancellation, generation) = {
            let data = slot.data.lock().await;
            if data.view.state != ConnectionState::Connected
                || data.connection_id != Some(host_session_id)
                || data.view.host_session_id != Some(host_session_id)
            {
                return Err(stale_session());
            }
            let transport = data.transport.clone().ok_or_else(stale_session)?;
            (transport, data.cancel.clone(), data.generation)
        };
        let reading =
            ubgops_discovery::observe_monitor(transport.as_ref(), cancellation.clone()).await?;
        let data = slot.data.lock().await;
        if cancellation.is_cancelled()
            || data.generation != generation
            || data.view.state != ConnectionState::Connected
            || data.connection_id != Some(host_session_id)
        {
            return Err(cancelled());
        }
        let mut baselines = self.monitor_baselines.lock().await;
        let previous = baselines
            .get(&host_id)
            .filter(|state| state.session_id == host_session_id);
        // Probe-specific monotonic Instant timestamps inside MonitorReading/MonitorBaseline
        // govern network and disk rates; never fall back to sample-completion elapsed time.
        let (sample, baseline) = ubgops_discovery::derive_sample(
            host_id,
            host_session_id,
            reading,
            previous.map(|state| &state.baseline),
            None,
        );
        baselines.insert(
            host_id,
            MonitorState {
                session_id: host_session_id,
                baseline,
            },
        );
        Ok(sample)
    }

    pub(super) async fn clear_monitor(&self, host_id: HostId) {
        self.monitor_baselines.lock().await.remove(&host_id);
    }

    pub(super) async fn remove_monitor(&self, host_id: HostId) {
        self.monitor_baselines.lock().await.remove(&host_id);
        self.monitor_gates.lock().await.remove(&host_id);
    }
}

fn stale_session() -> AppError {
    AppError::new(
        ErrorCode::Conflict,
        "The monitoring request does not belong to the active host session.",
    )
}
