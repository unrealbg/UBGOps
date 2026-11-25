//! Opt-in fixed-command monitoring validation against the owned OpenSSH fixture.

use std::{
    collections::HashMap,
    env, fs,
    io::Write,
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use ubgops_model::{
    AuthenticationMethod, DiskDeviceKind, ErrorCode, Host, HostConnectionConfig, HostId,
    HostSessionId,
};
use ubgops_operations::RemoteSession;
use ubgops_secrets::Credential;
use ubgops_ssh::{KnownHosts, SshProvider};
use zeroize::Zeroizing;

fn read_independent_diskstats(distro: &str) -> HashMap<String, (u64, u64)> {
    let output = Command::new("wsl.exe")
        .args(["-d", distro, "-u", "root", "--", "cat", "/proc/diskstats"])
        .output()
        .expect("read fixture /proc/diskstats");
    assert!(
        output.status.success(),
        "wsl.exe /proc/diskstats exited with {:?}",
        output.status
    );
    let raw = String::from_utf8(output.stdout).expect("utf-8 diskstats");
    let mut map = HashMap::new();
    for line in raw.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 14
            && let (Ok(read_sec), Ok(write_sec)) = (cols[5].parse::<u64>(), cols[9].parse::<u64>())
        {
            map.insert(cols[2].to_owned(), (read_sec, write_sec));
        }
    }
    map
}

#[tokio::test]
#[ignore = "requires tools/openssh-fixture disposable real OpenSSH server"]
async fn openssh_monitoring_interoperability() {
    let value = |name: &str| env::var(name).unwrap_or_else(|_| panic!("missing {name}"));
    let host = Host {
        id: HostId::new(),
        display_name: "Disposable OpenSSH monitoring fixture".into(),
        connection: HostConnectionConfig {
            hostname: value("UBGOPS_OPENSSH_HOST"),
            port: value("UBGOPS_OPENSSH_PORT").parse().expect("port"),
            username: value("UBGOPS_OPENSSH_USER"),
            authentication: AuthenticationMethod::Password,
        },
    };
    assert_ne!(
        host.connection.port, 22,
        "fixture must use a non-default port"
    );
    let password = Zeroizing::new(value("UBGOPS_OPENSSH_PASSWORD"));
    let pins = Arc::new(KnownHosts::open(value("UBGOPS_OPENSSH_PIN_DB")).expect("known hosts"));
    assert_eq!(
        pins.fingerprint(&host.connection.hostname, host.connection.port)
            .expect("pin lookup")
            .expect("phase A trusted fixture")
            .sha256,
        value("UBGOPS_OPENSSH_FINGERPRINT_A")
    );
    let provider = SshProvider::new(pins);
    let session = provider
        .connect(
            &host,
            Credential {
                password: Some(password),
                private_key: None,
                passphrase: None,
            },
            CancellationToken::new(),
        )
        .await
        .expect("fixture connection");
    let host_session_id = HostSessionId::new();
    let owned_distro = env::var("UBGOPS_OPENSSH_DISTRO")
        .ok()
        .filter(|name| name.starts_with("UBGOps-OpenSSH-"));
    let independent_before = owned_distro.as_deref().map(|distro| {
        let t0 = Instant::now();
        (t0, read_independent_diskstats(distro))
    });

    let first = ubgops_discovery::observe_monitor(session.as_ref(), CancellationToken::new())
        .await
        .expect("first observation");
    let (first, baseline) =
        ubgops_discovery::derive_sample(host.id, host_session_id, first, None, None);
    assert!(first.cpu_usage_percent.is_none());
    assert!(first.network_rx_bytes_per_second.is_none());
    assert!(first.disk_io.is_none());
    assert!(first.memory_total_bytes.is_some() && first.swap_total_bytes.is_some());
    assert!(first.root_total_bytes.is_some());

    if let Some(distro) = owned_distro.as_deref() {
        let write_out = Command::new("wsl.exe")
            .args([
                "-d",
                distro,
                "-u",
                "root",
                "--",
                "sh",
                "-c",
                "trap 'rm -f /tmp/ubgops-io-check' EXIT; dd if=/dev/zero of=/tmp/ubgops-io-check bs=4096 count=1024 conv=fdatasync 2>/dev/null; sync",
            ])
            .output()
            .expect("bounded temp write on fixture");
        assert!(
            write_out.status.success(),
            "bounded fixture write failed: {:?}",
            write_out.status
        );
    }

    tokio::time::sleep(Duration::from_millis(1200)).await;
    let second = ubgops_discovery::observe_monitor(session.as_ref(), CancellationToken::new())
        .await
        .expect("second observation");
    let (second, _) =
        ubgops_discovery::derive_sample(host.id, host_session_id, second, Some(&baseline), None);
    let cpu = second.cpu_usage_percent.expect("CPU delta");
    assert!((0.0..=100.0).contains(&cpu));
    assert!(
        second
            .network_rx_bytes_per_second
            .is_some_and(|value| value >= 0.0)
    );
    assert!(
        second
            .network_tx_bytes_per_second
            .is_some_and(|value| value >= 0.0)
    );
    let disk_io = second.disk_io.as_ref().expect("Disk I/O sample");
    let primary_name = disk_io
        .primary_device
        .as_deref()
        .expect("primary device name");
    assert!(disk_io.read_bytes_per_second.is_finite() && disk_io.read_bytes_per_second >= 0.0);
    assert!(disk_io.write_bytes_per_second.is_finite() && disk_io.write_bytes_per_second >= 0.0);
    assert!(!disk_io.devices.is_empty());
    assert!(
        second.warnings.is_empty(),
        "fixture monitoring warnings: {:?}",
        second.warnings
    );

    if let (Some(distro), Some((t0, before_map))) = (owned_distro.as_deref(), independent_before) {
        let after_map = read_independent_diskstats(distro);
        let ind_elapsed = t0.elapsed();
        let &(before_read, before_write) = before_map
            .get(primary_name)
            .expect("primary device in independent before diskstats");
        let &(after_read, after_write) = after_map
            .get(primary_name)
            .expect("primary device in independent after diskstats");
        let delta_written_sectors = after_write
            .checked_sub(before_write)
            .expect("monotonic sectors written");
        let delta_read_sectors = after_read
            .checked_sub(before_read)
            .expect("monotonic sectors read");
        assert!(
            delta_written_sectors > 0,
            "expected positive written sector delta"
        );
        let ind_write_bps = (delta_written_sectors as f64 * 512.0) / ind_elapsed.as_secs_f64();
        let ind_read_bps = (delta_read_sectors as f64 * 512.0) / ind_elapsed.as_secs_f64();
        let ubgops_write_bps = disk_io.write_bytes_per_second;
        let denom = ubgops_write_bps.max(ind_write_bps);
        let rel_diff = (ubgops_write_bps - ind_write_bps).abs() / denom;
        let _ = writeln!(
            std::io::stdout(),
            "OPENSSH_DISK_IO_VERIFY: device={primary_name} major={} minor={} kind={:?} root_backing={} diskseq={:?} device_id={:?} ind_elapsed_s={:.3} delta_write_sectors={} ubgops_write_bps={:.2} ind_write_bps={:.2} ubgops_read_bps={:.2} ind_read_bps={:.2} rel_diff={:.4}",
            disk_io.primary_major,
            disk_io.primary_minor,
            disk_io.primary_kind,
            disk_io.is_root_backing,
            disk_io.primary_disk_seq,
            disk_io.primary_device_id,
            ind_elapsed.as_secs_f64(),
            delta_written_sectors,
            ubgops_write_bps,
            ind_write_bps,
            disk_io.read_bytes_per_second,
            ind_read_bps,
            rel_diff
        );
        assert!(
            disk_io.is_root_backing,
            "expected root backing confirmation on Alpine WSL2 fixture"
        );
        assert_eq!(disk_io.primary_kind, DiskDeviceKind::VirtualDisk);
        assert!(
            disk_io.primary_disk_seq.is_some(),
            "expected kernel diskseq on WSL2 6.x"
        );
        assert!(
            ubgops_write_bps > 0.0,
            "expected positive UBGOps write rate"
        );
        assert!(
            rel_diff <= 0.35,
            "UBGOps write rate {ubgops_write_bps:.2} diverged from independent counter rate {ind_write_bps:.2} (rel_diff={rel_diff:.4})"
        );
    }

    session.disconnect().await.expect("disconnect");
    let error = ubgops_discovery::observe_monitor(session.as_ref(), CancellationToken::new())
        .await
        .expect_err("closed session cannot be sampled");
    assert_eq!(error.code, ErrorCode::Connection);
    drop(provider);
    let _ = fs::metadata(value("UBGOPS_OPENSSH_LOG")).expect("owned fixture log");
}
