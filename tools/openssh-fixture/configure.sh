#!/bin/sh
set -eu

run_root=$1
port=$2
fixture_user=ubgops_fixture
fixture_dir=/opt/ubgops-fixture

apk update
apk add --no-cache openssh-server shadow ncurses-terminfo-base vim

if ! id "$fixture_user" >/dev/null 2>&1; then
  adduser -D -h "/home/$fixture_user" -s /bin/sh "$fixture_user"
fi

password=$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')
passphrase=$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')
printf '%s:%s\n' "$fixture_user" "$password" | chpasswd

install -d -m 700 "$run_root" "$fixture_dir"
install -d -m 700 -o "$fixture_user" -g "$fixture_user" "/home/$fixture_user/.ssh"

ssh-keygen -q -t ed25519 -N '' -f "$run_root/client_ed25519"
ssh-keygen -q -t ed25519 -N "$passphrase" -f "$run_root/client_ed25519_protected"
cat "$run_root/client_ed25519.pub" "$run_root/client_ed25519_protected.pub" > "/home/$fixture_user/.ssh/authorized_keys"
chown "$fixture_user:$fixture_user" "/home/$fixture_user/.ssh/authorized_keys"
chmod 600 "/home/$fixture_user/.ssh/authorized_keys"

ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/host_ed25519_a"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/host_ed25519_b"
cp "$fixture_dir/host_ed25519_a" "$fixture_dir/host_ed25519"
cp "$fixture_dir/host_ed25519_a.pub" "$fixture_dir/host_ed25519.pub"
chmod 600 "$fixture_dir"/host_ed25519*

cat > "$fixture_dir/sshd_config" <<EOF
Port $port
ListenAddress 0.0.0.0
Protocol 2
HostKey $fixture_dir/host_ed25519
PidFile /run/ubgops-fixture-sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
PasswordAuthentication yes
PubkeyAuthentication yes
KbdInteractiveAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
StrictModes yes
AllowUsers $fixture_user
AllowTcpForwarding no
GatewayPorts no
PermitTunnel no
PermitUserEnvironment no
X11Forwarding no
PrintMotd no
LogLevel VERBOSE
Subsystem sftp internal-sftp
EOF

sshd -t -f "$fixture_dir/sshd_config"

fingerprint_a=$(ssh-keygen -lf "$fixture_dir/host_ed25519_a.pub" -E sha256 | awk '{print $2}')
fingerprint_b=$(ssh-keygen -lf "$fixture_dir/host_ed25519_b.pub" -E sha256 | awk '{print $2}')
alpine_version=$(cat /etc/alpine-release)
openssh_package=$(apk info -v | grep '^openssh-server-' | head -n 1)

cat > "$run_root/fixture-secrets.env" <<EOF
UBGOPS_OPENSSH_HOST=127.0.0.1
UBGOPS_OPENSSH_PORT=$port
UBGOPS_OPENSSH_USER=$fixture_user
UBGOPS_OPENSSH_PASSWORD=$password
UBGOPS_OPENSSH_PRIVATE_KEY=$run_root/client_ed25519
UBGOPS_OPENSSH_PROTECTED_KEY=$run_root/client_ed25519_protected
UBGOPS_OPENSSH_KEY_PASSPHRASE=$passphrase
UBGOPS_OPENSSH_PIN_DB=$run_root/known-hosts.db
UBGOPS_OPENSSH_LOG=$run_root/sshd.log
UBGOPS_OPENSSH_FINGERPRINT_A=$fingerprint_a
UBGOPS_OPENSSH_FINGERPRINT_B=$fingerprint_b
EOF
chmod 600 "$run_root/fixture-secrets.env" "$run_root"/client_ed25519*

cat > "$run_root/fixture-metadata.env" <<EOF
ALPINE_VERSION=$alpine_version
OPENSSH_PACKAGE=$openssh_package
SSH_PORT=$port
SSH_USER=$fixture_user
HOST_KEY_ALGORITHM=ssh-ed25519
HOST_FINGERPRINT_A=$fingerprint_a
HOST_FINGERPRINT_B=$fingerprint_b
EOF
chmod 600 "$run_root/fixture-metadata.env"
