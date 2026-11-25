use crate::{AppError, HostId, HostSessionId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// High-level storage layer classification derived from kernel sysfs metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DiskDeviceKind {
    PhysicalDisk,
    VirtualDisk,
    Partition,
    DeviceMapper,
    MdRaid,
    Unknown,
}

/// Throughput counters and verified kernel identity for one block device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiskIoDeviceSample {
    pub name: String,
    pub major: u32,
    pub minor: u32,
    pub kind: DiskDeviceKind,
    pub is_root_backing: bool,
    pub read_bytes_per_second: f64,
    pub write_bytes_per_second: f64,
}

/// Primary storage I/O throughput sample without double-counting stacked devices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiskIoSample {
    pub primary_device: Option<String>,
    pub primary_kind: DiskDeviceKind,
    pub read_bytes_per_second: f64,
    pub write_bytes_per_second: f64,
    pub devices: Vec<DiskIoDeviceSample>,
}

/// One bounded, read-only observation for a single connected SSH session.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostMonitorSample {
    pub host_id: HostId,
    pub host_session_id: HostSessionId,
    pub observed_at: String,
    pub cpu_usage_percent: Option<f64>,
    #[ts(as = "Option<f64>")]
    pub memory_total_bytes: Option<u64>,
    #[ts(as = "Option<f64>")]
    pub memory_used_bytes: Option<u64>,
    #[ts(as = "Option<f64>")]
    pub swap_total_bytes: Option<u64>,
    #[ts(as = "Option<f64>")]
    pub swap_used_bytes: Option<u64>,
    #[ts(as = "Option<f64>")]
    pub root_total_bytes: Option<u64>,
    #[ts(as = "Option<f64>")]
    pub root_used_bytes: Option<u64>,
    pub network_rx_bytes_per_second: Option<f64>,
    pub network_tx_bytes_per_second: Option<f64>,
    pub disk_io: Option<DiskIoSample>,
    pub warnings: Vec<AppError>,
}
