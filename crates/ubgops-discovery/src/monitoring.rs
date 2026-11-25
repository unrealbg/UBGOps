use crate::parsers;
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
use ubgops_model::{
    AppError, DiskDeviceKind, DiskIoDeviceSample, DiskIoSample, ErrorCode, HostId,
    HostMonitorSample, HostSessionId,
};
use ubgops_operations::{OperationEngine, ReadOnlyCommand, RemoteSession};

const MAX_CPU_FIELDS: usize = 16;
const MAX_INTERFACES: usize = 128;
const MAX_INTERFACE_NAME: usize = 64;
const MAX_DISK_STAT_LINES: usize = 512;
const MAX_BLOCK_DEVICES: usize = 128;
const MAX_REPORTED_DISK_DEVICES: usize = 16;
const MAX_DEVICE_NAME: usize = 64;
const SECTOR_BYTES: u128 = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CpuCounters {
    fields: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkCounters {
    interfaces: BTreeMap<String, (u64, u64)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskStatEntry {
    pub major: u32,
    pub minor: u32,
    pub sectors_read: u64,
    pub sectors_written: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockDeviceMeta {
    pub name: String,
    pub major: u32,
    pub minor: u32,
    pub size_sectors: u64,
    pub is_partition: bool,
    pub is_dm: bool,
    pub dm_name: Option<String>,
    pub is_md: bool,
    pub has_holders: bool,
    pub sysfs_path: String,
    pub vendor: String,
    pub model: String,
    pub disk_seq: Option<u64>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DiskCounterEntry {
    major: u32,
    minor: u32,
    size_sectors: u64,
    kind: DiskDeviceKind,
    disk_seq: Option<u64>,
    device_id: Option<String>,
    sysfs_path: String,
    is_partition: bool,
    has_holders: bool,
    is_root_backing: bool,
    sectors_read: u64,
    sectors_written: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskCounters {
    primary_device: String,
    primary_major: u32,
    primary_minor: u32,
    primary_kind: DiskDeviceKind,
    primary_disk_seq: Option<u64>,
    primary_device_id: Option<String>,
    is_root_backing: bool,
    entries: BTreeMap<String, DiskCounterEntry>,
}

#[derive(Debug, Clone)]
pub struct MonitorReading {
    pub observed_at: String,
    pub cpu: Option<CpuCounters>,
    pub memory: Option<(u64, u64)>,
    pub swap: Option<(u64, u64)>,
    pub root: Option<(u64, u64)>,
    pub root_source: Option<String>,
    pub network: Option<NetworkCounters>,
    pub network_observed_at: Option<Instant>,
    pub disk_io: Option<DiskCounters>,
    pub disk_observed_at: Option<Instant>,
    pub warnings: Vec<AppError>,
}

#[derive(Debug, Clone)]
pub struct MonitorBaseline {
    cpu: Option<CpuCounters>,
    network: Option<NetworkCounters>,
    network_observed_at: Option<Instant>,
    disk_io: Option<DiskCounters>,
    disk_observed_at: Option<Instant>,
}

fn invalid() -> AppError {
    AppError::new(
        ErrorCode::Discovery,
        "The host returned an unsupported monitoring value.",
    )
}

pub fn parse_cpu(output: &str) -> Result<CpuCounters, AppError> {
    let row = output
        .lines()
        .find(|line| line.starts_with("cpu "))
        .ok_or_else(invalid)?;
    let values = row
        .split_whitespace()
        .skip(1)
        .map(|part| part.parse::<u64>().map_err(|_| invalid()))
        .collect::<Result<Vec<_>, _>>()?;
    if values.len() < 4 || values.len() > MAX_CPU_FIELDS {
        return Err(invalid());
    }
    // Validate that the counters relevant to the formula can be summed.
    values.iter().take(8).try_fold(0_u64, |sum, value| {
        sum.checked_add(*value).ok_or_else(invalid)
    })?;
    Ok(CpuCounters { fields: values })
}

pub fn parse_swap(output: &str) -> Result<(u64, u64), AppError> {
    let mut total = None;
    let mut free = None;
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key != "SwapTotal" && key != "SwapFree" {
            continue;
        }
        let mut parts = value.split_whitespace();
        let bytes = parts
            .next()
            .ok_or_else(invalid)?
            .parse::<u64>()
            .map_err(|_| invalid())?
            .checked_mul(1024)
            .ok_or_else(invalid)?;
        if parts.next() != Some("kB") || parts.next().is_some() {
            return Err(invalid());
        }
        let target = if key == "SwapTotal" {
            &mut total
        } else {
            &mut free
        };
        if target.replace(bytes).is_some() {
            return Err(invalid());
        }
    }
    let (total, free) = (total.ok_or_else(invalid)?, free.ok_or_else(invalid)?);
    Ok((total, total.checked_sub(free).ok_or_else(invalid)?))
}

pub fn parse_network(output: &str) -> Result<NetworkCounters, AppError> {
    let mut interfaces = BTreeMap::new();
    for line in output
        .lines()
        .skip(2)
        .filter(|line| !line.trim().is_empty())
    {
        if interfaces.len() >= MAX_INTERFACES {
            return Err(invalid());
        }
        let (name, counters) = line.split_once(':').ok_or_else(invalid)?;
        let name = name.trim();
        if name.is_empty()
            || name.len() > MAX_INTERFACE_NAME
            || name.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(invalid());
        }
        let values = counters
            .split_whitespace()
            .map(|part| part.parse::<u64>().map_err(|_| invalid()))
            .collect::<Result<Vec<_>, _>>()?;
        if values.len() != 16
            || interfaces
                .insert(name.to_owned(), (values[0], values[8]))
                .is_some()
        {
            return Err(invalid());
        }
    }
    if interfaces.is_empty() {
        return Err(invalid());
    }
    aggregate_network(&interfaces)?;
    Ok(NetworkCounters { interfaces })
}

fn aggregate_network(values: &BTreeMap<String, (u64, u64)>) -> Result<(u64, u64), AppError> {
    values
        .iter()
        .filter(|(name, _)| name.as_str() != "lo")
        .try_fold((0_u64, 0_u64), |(rx, tx), (_, (next_rx, next_tx))| {
            Ok((
                rx.checked_add(*next_rx).ok_or_else(invalid)?,
                tx.checked_add(*next_tx).ok_or_else(invalid)?,
            ))
        })
}

fn cpu_percent(current: &CpuCounters, previous: &CpuCounters) -> Option<f64> {
    if current.fields.len() != previous.fields.len() {
        return None;
    }
    let current = &current.fields[..current.fields.len().min(8)];
    let previous = &previous.fields[..previous.fields.len().min(8)];
    let deltas = current
        .iter()
        .zip(previous)
        .map(|(a, b)| a.checked_sub(*b))
        .collect::<Option<Vec<_>>>()?;
    let total = deltas
        .iter()
        .try_fold(0_u64, |sum, value| sum.checked_add(*value))?;
    if total == 0 {
        return None;
    }
    let idle = deltas[3].checked_add(*deltas.get(4).unwrap_or(&0))?;
    let busy = total.checked_sub(idle)?;
    let value = busy as f64 / total as f64 * 100.0;
    if value.is_finite() && (-1e-9..=100.0 + 1e-9).contains(&value) {
        Some(value.clamp(0.0, 100.0))
    } else {
        None
    }
}

fn network_rates(
    current: &NetworkCounters,
    previous: &NetworkCounters,
    elapsed: Duration,
) -> Option<(f64, f64)> {
    if elapsed.is_zero() {
        return None;
    }
    let current_names = current.interfaces.keys().collect::<BTreeSet<_>>();
    let previous_names = previous.interfaces.keys().collect::<BTreeSet<_>>();
    if current_names != previous_names {
        return None;
    }
    let mut rx_delta = 0_u64;
    let mut tx_delta = 0_u64;
    for (name, (rx, tx)) in &current.interfaces {
        let (old_rx, old_tx) = previous.interfaces.get(name)?;
        let (drx, dtx) = (rx.checked_sub(*old_rx)?, tx.checked_sub(*old_tx)?);
        if name != "lo" {
            rx_delta = rx_delta.checked_add(drx)?;
            tx_delta = tx_delta.checked_add(dtx)?;
        }
    }
    let seconds = elapsed.as_secs_f64();
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    let rates = (rx_delta as f64 / seconds, tx_delta as f64 / seconds);
    (rates.0.is_finite() && rates.1.is_finite()).then_some(rates)
}

fn valid_block_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_DEVICE_NAME
        && !name
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '/')
}

fn is_noise_block_device(name: &str) -> bool {
    name.starts_with("loop")
        || name.starts_with("ram")
        || name.starts_with("zram")
        || name.starts_with("sr")
        || name.starts_with("fd")
}

/// Parses `/proc/diskstats` using documented 14-, 18-, or 20-field rows (sectors = 512 bytes).
pub fn parse_diskstats(output: &str) -> Result<BTreeMap<String, DiskStatEntry>, AppError> {
    let mut entries = BTreeMap::new();
    let mut lines = 0usize;
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        lines += 1;
        if lines > MAX_DISK_STAT_LINES {
            return Err(invalid());
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Linux Documentation/admin-guide/iostats.rst defines 14 base fields,
        // +4 discard fields (kernel 4.18), and +2 flush fields (kernel 5.5).
        if !matches!(cols.len(), 14 | 18 | 20) {
            return Err(invalid());
        }
        let major = cols[0].parse::<u32>().map_err(|_| invalid())?;
        let minor = cols[1].parse::<u32>().map_err(|_| invalid())?;
        let name = cols[2];
        if !valid_block_name(name) {
            return Err(invalid());
        }
        let numeric: Vec<u64> = cols[3..]
            .iter()
            .map(|part| part.parse::<u64>().map_err(|_| invalid()))
            .collect::<Result<Vec<_>, _>>()?;
        let entry = DiskStatEntry {
            major,
            minor,
            sectors_read: numeric[2],
            sectors_written: numeric[6],
        };
        if entries.insert(name.to_owned(), entry).is_some() {
            return Err(invalid());
        }
    }
    if entries.is_empty() {
        return Err(invalid());
    }
    Ok(entries)
}

fn parse_flag_bit(value: &str) -> Result<bool, AppError> {
    match value {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(invalid()),
    }
}

fn clean_sysfs_text(value: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.len() > 512 || trimmed.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(trimmed.to_owned())
}

/// Parses bounded 13-column tab-separated metadata from `/sys/class/block/*`.
pub fn parse_block_metadata(output: &str) -> Result<BTreeMap<String, BlockDeviceMeta>, AppError> {
    let mut devices = BTreeMap::new();
    for raw in output.lines().filter(|line| !line.trim().is_empty()) {
        if devices.len() >= MAX_BLOCK_DEVICES {
            return Err(invalid());
        }
        let line = raw.trim_end_matches('\r');
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() != 13 {
            return Err(invalid());
        }
        let name = cols[0];
        if !valid_block_name(name) {
            return Err(invalid());
        }
        let (maj_str, min_str) = cols[1].split_once(':').ok_or_else(invalid)?;
        let major = maj_str.parse::<u32>().map_err(|_| invalid())?;
        let minor = min_str.parse::<u32>().map_err(|_| invalid())?;
        let size_sectors = cols[2].parse::<u64>().map_err(|_| invalid())?;
        let is_partition = parse_flag_bit(cols[3])?;
        let is_dm = parse_flag_bit(cols[4])?;
        let dm_name_text = clean_sysfs_text(cols[5])?;
        let dm_name = (!dm_name_text.is_empty()).then_some(dm_name_text);
        let is_md = parse_flag_bit(cols[6])?;
        let has_holders = parse_flag_bit(cols[7])?;
        let sysfs_path = clean_sysfs_text(cols[8])?;
        let vendor = clean_sysfs_text(cols[9])?;
        let model = clean_sysfs_text(cols[10])?;
        let disk_seq_text = clean_sysfs_text(cols[11])?;
        let disk_seq = if disk_seq_text.is_empty() {
            None
        } else {
            Some(disk_seq_text.parse::<u64>().map_err(|_| invalid())?)
        };
        let device_id_text = clean_sysfs_text(cols[12])?;
        if device_id_text.len() > 128 {
            return Err(invalid());
        }
        let device_id = (!device_id_text.is_empty()).then_some(device_id_text);
        let meta = BlockDeviceMeta {
            name: name.to_owned(),
            major,
            minor,
            size_sectors,
            is_partition,
            is_dm,
            dm_name,
            is_md,
            has_holders,
            sysfs_path,
            vendor,
            model,
            disk_seq,
            device_id,
        };
        if devices.insert(name.to_owned(), meta).is_some() {
            return Err(invalid());
        }
    }
    if devices.is_empty() {
        return Err(invalid());
    }
    Ok(devices)
}

/// Conservatively classifies a block device without claiming bare-metal physical storage
/// solely from a PCI sysfs path or inferring virtualized storage to be physical.
pub fn classify_device(meta: &BlockDeviceMeta) -> DiskDeviceKind {
    if meta.is_partition {
        return DiskDeviceKind::Partition;
    }
    if meta.is_dm || meta.name.starts_with("dm-") {
        return DiskDeviceKind::DeviceMapper;
    }
    if meta.is_md || meta.name.starts_with("md") {
        return DiskDeviceKind::MdRaid;
    }
    let sysfs = meta.sysfs_path.to_ascii_lowercase();
    let hw = format!("{} {}", meta.vendor, meta.model).to_ascii_lowercase();
    let is_virtual = meta.name.starts_with("vd")
        || meta.name.starts_with("xvd")
        || [
            "/virtual/",
            "virtio",
            "vmbus",
            "lnxsystm",
            "msft",
            "/xen",
            "/vbd-",
            "qemu",
            "vbox",
            "vmware",
            "hyper-v",
            "proxmox",
            "ovirt",
            "parallels",
        ]
        .iter()
        .any(|marker| sysfs.contains(marker))
        || [
            "virtual",
            "msft",
            "qemu",
            "vbox",
            "vmware",
            "virtio",
            "xen",
            "bochs",
            "red hat",
            "google",
            "amazon",
            "ec2",
            "ephemeral",
            "ebs",
            "hyper-v",
            "parallels",
        ]
        .iter()
        .any(|marker| hw.contains(marker));
    if is_virtual {
        DiskDeviceKind::VirtualDisk
    } else {
        DiskDeviceKind::Unknown
    }
}

/// Verifies `(major, minor)` consistency between procfs and sysfs and selects one unambiguous
/// primary device without double-counting parent/child layers or claiming unmatched fallbacks
/// back the root filesystem.
pub fn build_disk_counters(
    stats: &BTreeMap<String, DiskStatEntry>,
    meta: &BTreeMap<String, BlockDeviceMeta>,
    root_source: Option<&str>,
) -> Result<DiskCounters, AppError> {
    let mut entries = BTreeMap::new();
    let mut dm_names: BTreeMap<String, String> = BTreeMap::new();
    for (name, stat) in stats {
        if is_noise_block_device(name) {
            continue;
        }
        let Some(info) = meta.get(name) else {
            return Err(invalid());
        };
        if info.major != stat.major || info.minor != stat.minor {
            return Err(invalid());
        }
        if info.size_sectors == 0 {
            continue;
        }
        if let Some(dm_name) = &info.dm_name
            && dm_names.insert(dm_name.clone(), name.clone()).is_some()
        {
            return Err(invalid());
        }
        entries.insert(
            name.clone(),
            DiskCounterEntry {
                major: stat.major,
                minor: stat.minor,
                size_sectors: info.size_sectors,
                kind: classify_device(info),
                disk_seq: info.disk_seq,
                device_id: info.device_id.clone(),
                sysfs_path: info.sysfs_path.clone(),
                is_partition: info.is_partition,
                has_holders: info.has_holders,
                is_root_backing: false,
                sectors_read: stat.sectors_read,
                sectors_written: stat.sectors_written,
            },
        );
    }
    if entries.is_empty() {
        return Err(invalid());
    }

    let matched_root = root_source.and_then(|source| {
        if let Some(dm_label) = source.strip_prefix("/dev/mapper/") {
            dm_names.get(dm_label).cloned()
        } else if let Some(dev_name) = source.strip_prefix("/dev/") {
            entries.contains_key(dev_name).then(|| dev_name.to_owned())
        } else {
            None
        }
    });

    let (primary_device, is_root_backing) = if let Some(name) = matched_root {
        (name, true)
    } else {
        // Root source is non-block (e.g. overlayfs or /dev/root) or probe unavailable:
        // allow single-device fallback without asserting it backs `/`.
        let candidates: Vec<&String> = entries
            .iter()
            .filter(|(_, entry)| !entry.is_partition && !entry.has_holders)
            .map(|(name, _)| name)
            .collect();
        if candidates.len() != 1 {
            return Err(invalid());
        }
        (candidates[0].clone(), false)
    };

    if is_root_backing && let Some(primary) = entries.get_mut(&primary_device) {
        primary.is_root_backing = true;
    }
    let primary_entry = entries.get(&primary_device).ok_or_else(invalid)?;
    Ok(DiskCounters {
        primary_device,
        primary_major: primary_entry.major,
        primary_minor: primary_entry.minor,
        primary_kind: primary_entry.kind,
        primary_disk_seq: primary_entry.disk_seq,
        primary_device_id: primary_entry.device_id.clone(),
        is_root_backing,
        entries,
    })
}

fn same_device_identity(current: &DiskCounterEntry, previous: &DiskCounterEntry) -> bool {
    current.major == previous.major
        && current.minor == previous.minor
        && current.kind == previous.kind
        && current.size_sectors == previous.size_sectors
        && current.disk_seq == previous.disk_seq
        && current.device_id == previous.device_id
        && current.sysfs_path == previous.sysfs_path
        && current.is_root_backing == previous.is_root_backing
}

fn sector_rate(current: u64, previous: u64, seconds: f64) -> Option<f64> {
    let delta = current.checked_sub(previous)?;
    let bytes = (delta as u128).checked_mul(SECTOR_BYTES)?;
    let rate = bytes as f64 / seconds;
    rate.is_finite().then_some(rate)
}

fn disk_rates(
    current: &DiskCounters,
    previous: &DiskCounters,
    elapsed: Duration,
) -> Option<DiskIoSample> {
    if elapsed.is_zero()
        || current.primary_device != previous.primary_device
        || current.is_root_backing != previous.is_root_backing
    {
        return None;
    }
    let seconds = elapsed.as_secs_f64();
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    let cur_primary = current.entries.get(&current.primary_device)?;
    let prev_primary = previous.entries.get(&previous.primary_device)?;
    if !same_device_identity(cur_primary, prev_primary) {
        return None;
    }
    let read_bytes_per_second =
        sector_rate(cur_primary.sectors_read, prev_primary.sectors_read, seconds)?;
    let write_bytes_per_second = sector_rate(
        cur_primary.sectors_written,
        prev_primary.sectors_written,
        seconds,
    )?;

    let mut devices = Vec::with_capacity(current.entries.len().min(MAX_REPORTED_DISK_DEVICES));
    devices.push(DiskIoDeviceSample {
        name: current.primary_device.clone(),
        major: cur_primary.major,
        minor: cur_primary.minor,
        kind: cur_primary.kind,
        disk_seq: cur_primary.disk_seq.map(|seq| seq.to_string()),
        device_id: cur_primary.device_id.clone(),
        is_root_backing: cur_primary.is_root_backing,
        read_bytes_per_second,
        write_bytes_per_second,
    });
    for (name, cur) in &current.entries {
        if devices.len() >= MAX_REPORTED_DISK_DEVICES {
            break;
        }
        if name == &current.primary_device {
            continue;
        }
        let Some(prev) = previous.entries.get(name) else {
            continue;
        };
        if !same_device_identity(cur, prev) {
            continue;
        }
        let (Some(read_bps), Some(write_bps)) = (
            sector_rate(cur.sectors_read, prev.sectors_read, seconds),
            sector_rate(cur.sectors_written, prev.sectors_written, seconds),
        ) else {
            continue;
        };
        devices.push(DiskIoDeviceSample {
            name: name.clone(),
            major: cur.major,
            minor: cur.minor,
            kind: cur.kind,
            disk_seq: cur.disk_seq.map(|seq| seq.to_string()),
            device_id: cur.device_id.clone(),
            is_root_backing: cur.is_root_backing,
            read_bytes_per_second: read_bps,
            write_bytes_per_second: write_bps,
        });
    }

    Some(DiskIoSample {
        primary_device: Some(current.primary_device.clone()),
        primary_major: current.primary_major,
        primary_minor: current.primary_minor,
        primary_kind: current.primary_kind,
        primary_disk_seq: current.primary_disk_seq.map(|seq| seq.to_string()),
        primary_device_id: current.primary_device_id.clone(),
        is_root_backing: current.is_root_backing,
        read_bytes_per_second,
        write_bytes_per_second,
        devices,
    })
}

pub async fn observe_monitor(
    session: &dyn RemoteSession,
    cancellation: CancellationToken,
) -> Result<MonitorReading, AppError> {
    let engine = OperationEngine::default();
    let mut reading = MonitorReading {
        observed_at: chrono::Utc::now().to_rfc3339(),
        cpu: None,
        memory: None,
        swap: None,
        root: None,
        root_source: None,
        network: None,
        network_observed_at: None,
        disk_io: None,
        disk_observed_at: None,
        warnings: Vec::new(),
    };
    let mut raw_diskstats = None;
    let mut raw_block_meta = None;
    let mut disk_warning_code = None;
    for command in [
        ReadOnlyCommand::CpuStat,
        ReadOnlyCommand::Memory,
        ReadOnlyCommand::RootFilesystem,
        ReadOnlyCommand::NetworkDevices,
        ReadOnlyCommand::DiskStats,
        ReadOnlyCommand::BlockDeviceMetadata,
    ] {
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let result = engine
            .execute(session, &engine.plan(command), cancellation.clone())
            .await;
        let finished_at = Instant::now();
        match result {
            Ok(output) => {
                let parsed = match command {
                    ReadOnlyCommand::CpuStat => {
                        parse_cpu(&output).map(|value| reading.cpu = Some(value))
                    }
                    ReadOnlyCommand::Memory => {
                        parsers::memory(&output).map(|value| reading.memory = Some(value))
                    }
                    ReadOnlyCommand::RootFilesystem => parsers::root_filesystem_with_source(
                        &output,
                    )
                    .map(|(total, used, source)| {
                        reading.root = Some((total, used));
                        reading.root_source = Some(source);
                    }),
                    ReadOnlyCommand::NetworkDevices => parse_network(&output).map(|value| {
                        reading.network = Some(value);
                        reading.network_observed_at = Some(finished_at);
                    }),
                    ReadOnlyCommand::DiskStats => parse_diskstats(&output).map(|value| {
                        raw_diskstats = Some(value);
                        reading.disk_observed_at = Some(finished_at);
                    }),
                    ReadOnlyCommand::BlockDeviceMetadata => {
                        parse_block_metadata(&output).map(|value| raw_block_meta = Some(value))
                    }
                    _ => unreachable!(),
                };
                if command == ReadOnlyCommand::Memory
                    && let Err(error) = parse_swap(&output).map(|value| reading.swap = Some(value))
                {
                    reading.warnings.push(metric_warning("swap", error.code));
                }
                if let Err(error) = parsed {
                    if matches!(
                        command,
                        ReadOnlyCommand::DiskStats | ReadOnlyCommand::BlockDeviceMetadata
                    ) {
                        disk_warning_code.get_or_insert(error.code);
                    } else {
                        reading
                            .warnings
                            .push(metric_warning(command.kind(), error.code));
                    }
                }
            }
            Err(error) if error.code == ErrorCode::Cancelled || cancellation.is_cancelled() => {
                return Err(cancelled());
            }
            Err(error) if error.code == ErrorCode::Connection => return Err(error),
            Err(error) => {
                if command == ReadOnlyCommand::Memory {
                    reading.warnings.push(metric_warning("swap", error.code));
                }
                if matches!(
                    command,
                    ReadOnlyCommand::DiskStats | ReadOnlyCommand::BlockDeviceMetadata
                ) {
                    disk_warning_code.get_or_insert(error.code);
                } else {
                    reading
                        .warnings
                        .push(metric_warning(command.kind(), error.code));
                }
            }
        }
    }
    if let Some(code) = disk_warning_code {
        reading.disk_observed_at = None;
        reading
            .warnings
            .push(metric_warning("monitor.disk_io", code));
    } else if let (Some(stats), Some(meta)) = (raw_diskstats, raw_block_meta) {
        match build_disk_counters(&stats, &meta, reading.root_source.as_deref()) {
            Ok(counters) => reading.disk_io = Some(counters),
            Err(error) => {
                reading.disk_observed_at = None;
                reading
                    .warnings
                    .push(metric_warning("monitor.disk_io", error.code));
            }
        }
    }
    reading.observed_at = chrono::Utc::now().to_rfc3339();
    Ok(reading)
}

fn metric_warning(metric: &str, code: ErrorCode) -> AppError {
    let name = match metric {
        "monitor.cpu" => "CPU",
        "discovery.memory" => "memory",
        "swap" => "swap",
        "discovery.root_filesystem" => "root filesystem",
        "monitor.network" => "network",
        "monitor.disk_io" | "monitor.block_devices" => "disk I/O",
        _ => "monitoring",
    };
    AppError::new(code, format!("{name} monitoring is unavailable."))
}

fn cancelled() -> AppError {
    AppError::new(ErrorCode::Cancelled, "Host monitoring was cancelled.")
}

fn resolve_elapsed(
    current: Option<Instant>,
    previous: Option<Instant>,
    fallback: Option<Duration>,
) -> Option<Duration> {
    match (current, previous) {
        (Some(now), Some(old)) => now.checked_duration_since(old).filter(|d| !d.is_zero()),
        (None, None) => fallback.filter(|d| !d.is_zero()),
        (Some(_), None) | (None, Some(_)) => None,
    }
}

pub fn derive_sample(
    host_id: HostId,
    host_session_id: HostSessionId,
    reading: MonitorReading,
    previous: Option<&MonitorBaseline>,
    elapsed: Option<Duration>,
) -> (HostMonitorSample, MonitorBaseline) {
    let cpu_usage_percent = previous
        .and_then(|old| reading.cpu.as_ref().zip(old.cpu.as_ref()))
        .and_then(|(a, b)| cpu_percent(a, b));
    let network_elapsed = resolve_elapsed(
        reading.network_observed_at,
        previous.and_then(|old| old.network_observed_at),
        elapsed,
    );
    let (network_rx_bytes_per_second, network_tx_bytes_per_second) = previous
        .and_then(|old| reading.network.as_ref().zip(old.network.as_ref()))
        .and_then(|(a, b)| network_elapsed.and_then(|duration| network_rates(a, b, duration)))
        .map_or((None, None), |(rx, tx)| (Some(rx), Some(tx)));
    let disk_elapsed = resolve_elapsed(
        reading.disk_observed_at,
        previous.and_then(|old| old.disk_observed_at),
        elapsed,
    );
    let disk_io = previous
        .and_then(|old| reading.disk_io.as_ref().zip(old.disk_io.as_ref()))
        .and_then(|(a, b)| disk_elapsed.and_then(|duration| disk_rates(a, b, duration)));
    let baseline = MonitorBaseline {
        cpu: reading.cpu.clone(),
        network: reading.network.clone(),
        network_observed_at: reading.network_observed_at,
        disk_io: reading.disk_io.clone(),
        disk_observed_at: reading.disk_observed_at,
    };
    let sample = HostMonitorSample {
        host_id,
        host_session_id,
        observed_at: reading.observed_at,
        cpu_usage_percent,
        memory_total_bytes: reading.memory.map(|value| value.0),
        memory_used_bytes: reading.memory.map(|value| value.1),
        swap_total_bytes: reading.swap.map(|value| value.0),
        swap_used_bytes: reading.swap.map(|value| value.1),
        root_total_bytes: reading.root.map(|value| value.0),
        root_used_bytes: reading.root.map(|value| value.1),
        network_rx_bytes_per_second,
        network_tx_bytes_per_second,
        disk_io,
        warnings: reading.warnings,
    };
    (sample, baseline)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn reading(cpu: &str, network: &str) -> MonitorReading {
        MonitorReading {
            observed_at: "2026-09-25T00:00:00Z".into(),
            cpu: Some(parse_cpu(cpu).unwrap()),
            memory: Some((100, 25)),
            swap: Some((0, 0)),
            root: Some((100, 20)),
            root_source: Some("/dev/sdd".into()),
            network: Some(parse_network(network).unwrap()),
            network_observed_at: None,
            disk_io: Some(
                build_disk_counters(
                    &parse_diskstats(DISK_A).unwrap(),
                    &parse_block_metadata(META_VIRTUAL).unwrap(),
                    Some("/dev/sdd"),
                )
                .unwrap(),
            ),
            disk_observed_at: None,
            warnings: vec![],
        }
    }
    const NET_A: &str = "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n lo: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\n eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n";
    const NET_B: &str = "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n lo: 30 0 0 0 0 0 0 0 40 0 0 0 0 0 0 0\n eth0: 1500 0 0 0 0 0 0 0 3000 0 0 0 0 0 0 0\n";
    const DISK_A: &str = "   1       0 ram0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n   8      48 sdd 10 0 1000 0 20 0 2000 0 0 0 0 0 0 0 0 0 0\n";
    const DISK_B: &str = "   8      48 sdd 20 0 1100 0 40 0 2200 0 0 0 0 0 0 0 0 0 0\n";
    const META_VIRTUAL: &str = "sdd\t8:48\t2147483648\t0\t0\t\t0\t0\t../../devices/LNXSYSTM:00/ACPI0004:00/MSFT1000:00/host0/target0:0:0/0:0:0:3/block/sdd\tMsft\tVirtual Disk\t28\tnaa.60022480\n";

    #[test]
    fn parses_cpu_and_derives_known_delta() {
        let first = reading("cpu 100 0 50 850 10 0 0 0 1 2\ncpu0 1\n", NET_A);
        let (sample, baseline) =
            derive_sample(HostId::new(), HostSessionId::new(), first, None, None);
        assert!(sample.cpu_usage_percent.is_none());
        assert!(sample.disk_io.is_none());
        let mut second = reading("cpu 140 0 60 900 10 0 0 0 3 4\n", NET_B);
        second.disk_io = Some(
            build_disk_counters(
                &parse_diskstats(DISK_B).unwrap(),
                &parse_block_metadata(META_VIRTUAL).unwrap(),
                Some("/dev/sdd"),
            )
            .unwrap(),
        );
        let (sample, _) = derive_sample(
            sample.host_id,
            sample.host_session_id,
            second,
            Some(&baseline),
            Some(Duration::from_secs(5)),
        );
        assert_eq!(sample.cpu_usage_percent, Some(50.0));
        assert_eq!(sample.network_rx_bytes_per_second, Some(100.0));
        assert_eq!(sample.network_tx_bytes_per_second, Some(200.0));
        let disk = sample.disk_io.expect("disk I/O sample");
        assert_eq!(disk.primary_device.as_deref(), Some("sdd"));
        assert_eq!((disk.primary_major, disk.primary_minor), (8, 48));
        assert_eq!(disk.primary_kind, DiskDeviceKind::VirtualDisk);
        assert_eq!(disk.primary_disk_seq.as_deref(), Some("28"));
        assert_eq!(disk.primary_device_id.as_deref(), Some("naa.60022480"));
        assert!(disk.is_root_backing);
        // 100 sectors * 512 / 5s = 10240 B/s read; 200 sectors * 512 / 5s = 20480 B/s write
        assert_eq!(disk.read_bytes_per_second, 10_240.0);
        assert_eq!(disk.write_bytes_per_second, 20_480.0);
    }

    #[test]
    fn rejects_missing_malformed_overflow_and_resets() {
        assert!(parse_cpu("cpu0 1 2 3 4\n").is_err());
        assert!(parse_cpu("cpu 1 x 3 4\n").is_err());
        assert!(parse_cpu(&format!("cpu {} 1 1 1\n", u64::MAX)).is_err());
        let old = MonitorBaseline {
            cpu: Some(parse_cpu("cpu 10 1 1 10\n").unwrap()),
            network: Some(parse_network(NET_B).unwrap()),
            network_observed_at: None,
            disk_io: Some(
                build_disk_counters(
                    &parse_diskstats(DISK_B).unwrap(),
                    &parse_block_metadata(META_VIRTUAL).unwrap(),
                    Some("/dev/sdd"),
                )
                .unwrap(),
            ),
            disk_observed_at: None,
        };
        let current = reading("cpu 9 1 1 10\n", NET_A);
        let (sample, _) = derive_sample(
            HostId::new(),
            HostSessionId::new(),
            current,
            Some(&old),
            Some(Duration::from_secs(1)),
        );
        assert!(sample.cpu_usage_percent.is_none());
        assert!(sample.network_rx_bytes_per_second.is_none());
        assert!(sample.disk_io.is_none());
    }

    #[test]
    fn parses_swap_zero_active_and_rejects_bad_values() {
        assert_eq!(
            parse_swap("SwapTotal: 0 kB\nSwapFree: 0 kB\n").unwrap(),
            (0, 0)
        );
        assert_eq!(
            parse_swap("SwapTotal: 100 kB\nSwapFree: 40 kB\n").unwrap(),
            (102400, 61440)
        );
        for value in [
            "SwapTotal: 1 kB\n",
            "SwapTotal: 1 kB\nSwapTotal: 1 kB\nSwapFree: 0 kB\n",
            "SwapTotal: 1 kB\nSwapFree: 2 kB\n",
            "SwapTotal: 18446744073709551615 kB\nSwapFree: 0 kB\n",
        ] {
            assert!(parse_swap(value).is_err());
        }
    }

    #[test]
    fn parses_network_excludes_loopback_and_enforces_bounds() {
        let parsed = parse_network(NET_A).unwrap();
        assert_eq!(aggregate_network(&parsed.interfaces).unwrap(), (1000, 2000));
        let multiple = parse_network("a\nb\n lo: 9 0 0 0 0 0 0 0 9 0 0 0 0 0 0 0\n eth0: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\n\twlan0:\t30 0 0 0 0 0 0 0\t40 0 0 0 0 0 0 0\n").unwrap();
        assert_eq!(aggregate_network(&multiple.interfaces).unwrap(), (40, 60));
        assert!(parse_network("a\nb\n eth0: 1 2\n").is_err());
        assert!(parse_network("a\nb\n eth0: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n eth0: 2 0 0 0 0 0 0 0 2 0 0 0 0 0 0 0\n").is_err());
        let too_many = (0..129)
            .map(|i| format!("eth{i}: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(parse_network(&format!("a\nb\n{too_many}\n")).is_err());
        assert!(parse_network(&format!("a\nb\neth0: {} 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\neth1: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n", u64::MAX)).is_err());
        assert!(network_rates(&parsed, &parsed, Duration::ZERO).is_none());
    }

    #[test]
    fn parses_diskstats_14_18_and_20_fields_and_rejects_malformed() {
        let stats_14 = " 259 0 nvme0n1 1 0 100 0 2 0 200 0 0 0 0\n";
        let stats_18 = " 259 0 nvme0n1 1 0 100 0 2 0 200 0 0 0 0 0 0 0 0\n";
        let stats_20 = " 259 0 nvme0n1 1 0 100 0 2 0 200 0 0 0 0 0 0 0 0 0 0\n";
        for row in [stats_14, stats_18, stats_20] {
            let parsed = parse_diskstats(row).unwrap();
            let entry = parsed.get("nvme0n1").unwrap();
            assert_eq!((entry.major, entry.minor), (259, 0));
            assert_eq!((entry.sectors_read, entry.sectors_written), (100, 200));
        }
        for bad in [
            "",
            "   \n",
            " 8 0 sda 1 2 3\n",
            " 8 0 sda 1 0 2 0 3 0 4 0 0 0 0 0 0 0 0 0\n",
            " x 0 sda 1 0 2 0 3 0 4 0 0 0 0\n",
            " 8 0 bad/dev 1 0 2 0 3 0 4 0 0 0 0\n",
            " 8 0 sda 1 0 2 0 3 0 4 0 0 0 0\n 8 0 sda 1 0 2 0 3 0 4 0 0 0 0\n",
        ] {
            assert!(parse_diskstats(bad).is_err(), "expected error for: {bad:?}");
        }
    }

    #[test]
    fn classifies_devices_conservatively_and_prevents_double_counting_across_lvm_stack() {
        let stats = parse_diskstats(
            "   8 0 sda 10 0 500 0 20 0 900 0 0 0 0 0 0 0 0 0 0\n\
                8 1 sda1 10 0 500 0 20 0 900 0 0 0 0 0 0 0 0 0 0\n\
              253 0 dm-0 10 0 500 0 20 0 900 0 0 0 0 0 0 0 0 0 0\n\
              259 0 nvme0n1 1 0 100 0 2 0 200 0 0 0 0 0 0 0 0 0 0\n",
        )
        .unwrap();
        let meta = parse_block_metadata(
            "sda\t8:0\t100000\t0\t0\t\t0\t1\t../../devices/pci0000:00/0000:00:1f.2/ata1/host0/block/sda\tATA\tSamsung SSD 870\t11\tnaa.5002538\n\
             sda1\t8:1\t99000\t1\t0\t\t0\t1\t../../devices/pci0000:00/0000:00:1f.2/ata1/host0/block/sda/sda1\t\t\t11\t\n\
             dm-0\t253:0\t98000\t0\t1\tubuntu--vg-root\t0\t0\t../../devices/virtual/block/dm-0\t\t\t12\tLVM-abc\n\
             nvme0n1\t259:0\t200000\t0\t0\t\t0\t1\t../../devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1\t\tGeneric NVMe\t13\teui.001\n",
        )
        .unwrap();
        // Uncertain PCI storage must NOT be inferred as PhysicalDisk from PCI path alone.
        assert_eq!(classify_device(&meta["sda"]), DiskDeviceKind::Unknown);
        assert_eq!(classify_device(&meta["sda1"]), DiskDeviceKind::Partition);
        assert_eq!(classify_device(&meta["dm-0"]), DiskDeviceKind::DeviceMapper);
        assert_eq!(classify_device(&meta["nvme0n1"]), DiskDeviceKind::Unknown);

        let a = build_disk_counters(&stats, &meta, Some("/dev/mapper/ubuntu--vg-root")).unwrap();
        let stats_b = parse_diskstats(
            "   8 0 sda 10 0 510 0 20 0 920 0 0 0 0 0 0 0 0 0 0\n\
                8 1 sda1 10 0 510 0 20 0 920 0 0 0 0 0 0 0 0 0 0\n\
              253 0 dm-0 10 0 510 0 20 0 920 0 0 0 0 0 0 0 0 0 0\n\
              259 0 nvme0n1 1 0 100 0 2 0 200 0 0 0 0 0 0 0 0 0 0\n",
        )
        .unwrap();
        let b = build_disk_counters(&stats_b, &meta, Some("/dev/mapper/ubuntu--vg-root")).unwrap();
        let rates = disk_rates(&b, &a, Duration::from_secs(2)).unwrap();
        assert_eq!(rates.primary_device.as_deref(), Some("dm-0"));
        assert_eq!(rates.primary_kind, DiskDeviceKind::DeviceMapper);
        assert_eq!(rates.primary_disk_seq.as_deref(), Some("12"));
        assert_eq!(rates.primary_device_id.as_deref(), Some("LVM-abc"));
        assert!(rates.is_root_backing);
        // Must report dm-0 alone (10 sectors read, 20 written), NEVER 3x stacked sum.
        assert_eq!(rates.read_bytes_per_second, 2_560.0);
        assert_eq!(rates.write_bytes_per_second, 5_120.0);
        assert!(rates.devices[0].is_root_backing);
    }

    #[test]
    fn fails_closed_on_ambiguous_root_or_procfs_sysfs_mismatch() {
        let stats = parse_diskstats(
            " 8 0 sda 1 0 10 0 1 0 20 0 0 0 0 0 0 0 0 0 0\n\
              8 16 sdb 1 0 10 0 1 0 20 0 0 0 0 0 0 0 0 0 0\n",
        )
        .unwrap();
        let meta = parse_block_metadata(
            "sda\t8:0\t1000\t0\t0\t\t0\t0\t../../devices/virtual/block/sda\tQEMU\tQEMU HARDDISK\t1\t\n\
             sdb\t8:16\t1000\t0\t0\t\t0\t0\t../../devices/virtual/block/sdb\tQEMU\tQEMU HARDDISK\t2\t\n",
        )
        .unwrap();
        // Overlay root with two whole disks is ambiguous -> must fail closed.
        assert!(build_disk_counters(&stats, &meta, Some("overlay")).is_err());
        // Mismatched major:minor between /proc/diskstats and /sys/class/block must fail closed.
        let bad_meta = parse_block_metadata(
            "sda\t8:99\t1000\t0\t0\t\t0\t0\t../../devices/virtual/block/sda\tQEMU\tQEMU HARDDISK\t1\t\n",
        )
        .unwrap();
        assert!(build_disk_counters(&stats, &bad_meta, Some("/dev/sda")).is_err());
    }

    #[test]
    fn resets_baseline_on_reused_identifiers_with_changed_diskseq_id_size_or_sysfs_path() {
        let stats_a = parse_diskstats(" 8 48 sdd 1 0 100 0 1 0 200 0 0 0 0 0 0 0 0 0 0\n").unwrap();
        let stats_b = parse_diskstats(" 8 48 sdd 2 0 120 0 2 0 240 0 0 0 0 0 0 0 0 0 0\n").unwrap();
        let base_meta = parse_block_metadata(
            "sdd\t8:48\t204800\t0\t0\t\t0\t0\t../../devices/virtual/block/sdd\tQEMU\tQEMU HARDDISK\t28\tnaa.111\n",
        )
        .unwrap();
        let baseline = build_disk_counters(&stats_a, &base_meta, Some("/dev/sdd")).unwrap();

        for (label, changed_meta) in [
            (
                "diskseq",
                "sdd\t8:48\t204800\t0\t0\t\t0\t0\t../../devices/virtual/block/sdd\tQEMU\tQEMU HARDDISK\t29\tnaa.111\n",
            ),
            (
                "device_id",
                "sdd\t8:48\t204800\t0\t0\t\t0\t0\t../../devices/virtual/block/sdd\tQEMU\tQEMU HARDDISK\t28\tnaa.222\n",
            ),
            (
                "size",
                "sdd\t8:48\t409600\t0\t0\t\t0\t0\t../../devices/virtual/block/sdd\tQEMU\tQEMU HARDDISK\t28\tnaa.111\n",
            ),
            (
                "sysfs_path",
                "sdd\t8:48\t204800\t0\t0\t\t0\t0\t../../devices/pci0000:00/block/sdd\tQEMU\tQEMU HARDDISK\t28\tnaa.111\n",
            ),
        ] {
            let parsed_meta = parse_block_metadata(changed_meta).unwrap();
            let current = build_disk_counters(&stats_b, &parsed_meta, Some("/dev/sdd")).unwrap();
            assert!(
                disk_rates(&current, &baseline, Duration::from_secs(2)).is_none(),
                "expected baseline reset on {label} change"
            );
        }

        // Identical identity with valid sector increase and fractional interval (2.5s):
        // (20 * 512) / 2.5 = 4096.0 B/s read; (40 * 512) / 2.5 = 8192.0 B/s write.
        let same = build_disk_counters(&stats_b, &base_meta, Some("/dev/sdd")).unwrap();
        let exact = disk_rates(&same, &baseline, Duration::from_millis(2500)).unwrap();
        assert_eq!(exact.read_bytes_per_second, 4_096.0);
        assert_eq!(exact.write_bytes_per_second, 8_192.0);
    }

    #[test]
    fn distinguishes_single_device_fallback_from_confirmed_root_and_rejects_bad_monotonic_intervals()
     {
        let stats_a = parse_diskstats(" 8 0 sda 1 0 100 0 1 0 200 0 0 0 0 0 0 0 0 0 0\n").unwrap();
        let stats_b = parse_diskstats(" 8 0 sda 2 0 108 0 2 0 216 0 0 0 0 0 0 0 0 0 0\n").unwrap();
        let meta = parse_block_metadata(
            "sda\t8:0\t100000\t0\t0\t\t0\t0\t../../devices/virtual/block/sda\tQEMU\tQEMU HARDDISK\t7\twwid-7\n",
        )
        .unwrap();
        let fallback_a = build_disk_counters(&stats_a, &meta, Some("overlay")).unwrap();
        let fallback_b = build_disk_counters(&stats_b, &meta, Some("overlay")).unwrap();
        let fallback_rate = disk_rates(&fallback_b, &fallback_a, Duration::from_secs(4)).unwrap();
        assert!(!fallback_rate.is_root_backing);
        assert!(!fallback_rate.devices[0].is_root_backing);
        assert_eq!(fallback_rate.read_bytes_per_second, 1_024.0);
        assert_eq!(fallback_rate.write_bytes_per_second, 2_048.0);

        let root_b = build_disk_counters(&stats_b, &meta, Some("/dev/sda")).unwrap();
        assert!(disk_rates(&root_b, &fallback_a, Duration::from_secs(4)).is_none());

        // Strict resolve_elapsed never silently falls back to sample-completion duration.
        let t1 = Instant::now();
        let t2 = t1 + Duration::from_secs(2);
        assert_eq!(
            resolve_elapsed(Some(t2), Some(t1), Some(Duration::from_secs(9))),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            resolve_elapsed(Some(t1), Some(t2), Some(Duration::from_secs(5))),
            None
        );
        assert_eq!(
            resolve_elapsed(Some(t1), Some(t1), Some(Duration::from_secs(5))),
            None
        );
        assert_eq!(
            resolve_elapsed(Some(t2), None, Some(Duration::from_secs(5))),
            None
        );
        assert_eq!(
            resolve_elapsed(None, Some(t1), Some(Duration::from_secs(5))),
            None
        );
        assert_eq!(
            resolve_elapsed(None, None, Some(Duration::from_secs(5))),
            Some(Duration::from_secs(5))
        );
    }

    #[tokio::test]
    async fn observe_monitor_isolates_disk_io_failure_from_other_metrics() {
        struct PartialDiskSession {
            tick: AtomicUsize,
        }
        #[async_trait]
        impl RemoteSession for PartialDiskSession {
            async fn execute(
                &self,
                command: ReadOnlyCommand,
                _: CancellationToken,
            ) -> Result<String, AppError> {
                let n = self.tick.fetch_add(1, Ordering::Relaxed) as u64;
                match command {
                    ReadOnlyCommand::CpuStat => Ok(format!("cpu {} 0 50 {} 10 0 0 0\n", 100 + n, 850 + n)),
                    ReadOnlyCommand::Memory => {
                        Ok("MemTotal: 4096 kB\nMemAvailable: 2048 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n".into())
                    }
                    ReadOnlyCommand::RootFilesystem => Ok("/dev/sda 1000 200 800 20% /\n".into()),
                    ReadOnlyCommand::NetworkDevices => Ok("a\nb\n eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n".into()),
                    ReadOnlyCommand::DiskStats => Ok(" 8 0 sda 1 0 100 0 1 0 200 0 0 0 0 0 0 0 0 0 0\n".into()),
                    ReadOnlyCommand::BlockDeviceMetadata => Ok(String::new()),
                    _ => unreachable!(),
                }
            }
            async fn disconnect(&self) -> Result<(), AppError> {
                Ok(())
            }
            fn is_closed(&self) -> bool {
                false
            }
        }
        let reading = observe_monitor(
            &PartialDiskSession {
                tick: AtomicUsize::new(0),
            },
            CancellationToken::new(),
        )
        .await
        .expect("partial observation succeeds");
        assert!(reading.cpu.is_some());
        assert!(reading.memory.is_some());
        assert!(reading.network.is_some());
        assert!(reading.disk_io.is_none());
        assert_eq!(reading.warnings.len(), 1);
        assert_eq!(
            reading.warnings[0].message,
            "disk I/O monitoring is unavailable."
        );
    }
}
