import type { DiscoverySnapshot, HostSession } from '@ubgops/protocol';
import { Badge, Notice } from '@ubgops/ui';
import { observedTime, uptime } from './format';
import { Icon } from '../../components/Icon';

export function DiscoveryDetails({
  discovery,
  session,
  compactDrawer = false,
}: {
  discovery: DiscoverySnapshot;
  session: HostSession;
  compactDrawer?: boolean;
}) {
  const details = [
    ['Hostname', discovery.hostname],
    ['Operating system', discovery.os],
    ['OS version', discovery.osVersion],
    ['Kernel', discovery.kernel],
    ['Architecture', discovery.architecture],
    ['Uptime', uptime(discovery.uptimeSeconds)],
    [
      'System load (1m)',
      discovery.loadOne === null ? 'Unavailable' : discovery.loadOne.toFixed(2),
    ],
  ];

  return (
    <div className={`discovery-details ${compactDrawer ? 'discovery-details--drawer' : ''}`}>
      <div className="overview-columns">
        <section className="panel">
          <div className="panel-heading">
            <h2>System information</h2>
            <span className="panel-caption">Linux host snapshot</span>
          </div>
          <dl className="detail-list">
            {details.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || <span className="unavailable">Unavailable</span>}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Connection security</h2>
            <Badge tone="success">Verified</Badge>
          </div>
          <div className="security-summary">
            <span className="security-icon">
              <Icon name="security" size={20} />
            </span>
            <div>
              <strong>Trusted host identity</strong>
              <p>The server key matches your locally stored fingerprint.</p>
            </div>
          </div>
          <dl className="detail-list compact">
            <div>
              <dt>Key algorithm</dt>
              <dd>{session.identity?.fingerprint.algorithm ?? 'Unavailable'}</dd>
            </div>
            <div className="detail-stacked">
              <dt>SHA-256 fingerprint</dt>
              <dd className="fingerprint">
                {session.identity?.fingerprint.sha256 ?? 'Unavailable'}
              </dd>
            </div>
          </dl>
        </section>
      </div>
      <section className="panel capability-panel">
        <div className="panel-heading">
          <h2>Available capabilities</h2>
          <span className="panel-caption">Discovery registry</span>
        </div>
        <div className="capabilities">
          {session.capabilities.length ? (
            session.capabilities.map((capability) => (
              <span
                key={capability.id}
                className={`capability ${capability.available ? '' : 'capability--unavailable'}`}
              >
                <Icon name="services" size={14} />
                {capability.id}
                <span>{capability.available ? 'Available' : 'Unavailable'}</span>
              </span>
            ))
          ) : (
            <span className="muted">No capabilities reported for this host.</span>
          )}
        </div>
      </section>
      {discovery.warnings.length > 0 && (
        <Notice tone="warning">
          <strong>Some discovery information is unavailable.</strong>
          <ul className="warning-list">
            {discovery.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>{warning.message}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="discovery-footer">
        <span>
          <Icon name="security" size={14} />
          Read-only discovery · no remote agent
        </span>
        <span>Observed {observedTime(discovery.observedAt)}</span>
      </div>
    </div>
  );
}
