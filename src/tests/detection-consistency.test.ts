import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app';
import { AuditService } from '../services/audit-service';
import { stableId } from '../core/hash';
import { FastifyInstance } from 'fastify';

async function setup() {
  const app = buildApp();
  await app.ready();
  const audit = (app as unknown as { auditService: AuditService }).auditService;
  const ingest = async (assetId: string, metric: string, value: number, observedAt: number, quality: 'good' | 'suspect' | 'bad' = 'good') =>
    app.inject({
      method: 'POST',
      url: '/telemetry',
      payload: { assetId, metric, value, unit: 'C', observedAt, quality },
    });
  const detect = async (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/anomalies/detect', payload });
  return { app, audit, ingest, detect };
}

const ACTION = 'anomaly.detected';

test('normal success path: business fact, state change and audit fact land together', async () => {
  const { app, audit, ingest, detect } = await setup();
  await ingest('pump-1', 'temp', 120, 1000);
  await ingest('pump-1', 'temp', 130, 2000);

  const res = await detect({ assetId: 'pump-1', metric: 'temp', threshold: 100 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.state, 'committed');
  assert.equal(body.retryable, false);
  assert.ok(body.incident);
  assert.equal(body.incident.status, 'open');
  assert.equal(body.incident.evidence.length, 2);
  assert.ok(body.auditId);

  // Exactly one audit fact exists for the incident.
  const auditRes = await app.inject({ method: 'GET', url: `/audit?entityId=${body.incident.id}` });
  const entries = auditRes.json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, ACTION);
  assert.equal(entries[0].id, body.auditId);
  assert.equal(entries[0].entityId, body.incident.id);

  // Status endpoint reflects the committed operation.
  const status = await app.inject({ method: 'GET', url: `/anomalies/status/${body.idempotencyKey}` });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().state, 'committed');
  assert.equal(status.json().incident.id, body.incident.id);

  assert.ok(audit.available);
  await app.close();
});

test('audit outage: no incident without audit; failure is recorded and retryable', async () => {
  const { app, audit, ingest, detect } = await setup();
  await ingest('reactor-7', 'pressure', 200, 1000);

  audit.fail();
  assert.equal(audit.available, false);

  const res = await detect({ assetId: 'reactor-7', metric: 'pressure', threshold: 150 });
  assert.equal(res.statusCode, 503);
  const failed = res.json();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retryable, true);
  assert.equal(failed.errorCode, 'AUDIT_UNAVAILABLE');
  assert.match(failed.errorMessage, /audit storage unavailable/);
  assert.equal(failed.attempts.length, 1);
  assert.equal(failed.attempts[0].phase, 'audit');

  // Invariant: no incident may exist without its audit evidence.
  const expectedIncidentId = stableId('inc', [failed.idempotencyKey]);
  const rc = await app.inject({ method: 'GET', url: `/incidents/${expectedIncidentId}/root-cause` });
  assert.equal(rc.statusCode, 404);
  const auditCheck = await app.inject({ method: 'GET', url: `/audit?entityId=${expectedIncidentId}` });
  assert.deepEqual(auditCheck.json(), []);

  // Status query exposes the explicit retryable intermediate state with diagnostics.
  const status = await app.inject({ method: 'GET', url: `/anomalies/status/${failed.idempotencyKey}` });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().state, 'failed');
  assert.equal(status.json().errorCode, 'AUDIT_UNAVAILABLE');

  audit.restore();

  // Retry after recovery: same business identity, same ids, completes exactly once.
  const retry = await detect({ assetId: 'reactor-7', metric: 'pressure', threshold: 150 });
  assert.equal(retry.statusCode, 200);
  const recovered = retry.json();
  assert.equal(recovered.state, 'committed');
  assert.equal(recovered.idempotencyKey, failed.idempotencyKey);
  assert.equal(recovered.incident.id, expectedIncidentId);
  assert.equal(recovered.auditId, failed.auditId);
  assert.equal(recovered.attempts.length, 1, 'original failed attempt preserved for diagnosis');

  const entries = (await app.inject({ method: 'GET', url: `/audit?entityId=${expectedIncidentId}` })).json();
  assert.equal(entries.length, 1, 'no duplicate audit on retry');

  await app.close();
});

test('duplicate detections (before and after recovery) never create duplicate incident or audit', async () => {
  const { app, audit, ingest, detect } = await setup();
  await ingest('valve-3', 'flow', 90, 1000);

  // First call fails because audit is down.
  audit.fail();
  const r1 = (await detect({ assetId: 'valve-3', metric: 'flow', threshold: 80 })).json();
  assert.equal(r1.state, 'failed');

  // Retry while still down: same operation, another diagnostic attempt, still no incident.
  const r2 = (await detect({ assetId: 'valve-3', metric: 'flow', threshold: 80 })).json();
  assert.equal(r2.state, 'failed');
  assert.equal(r2.idempotencyKey, r1.idempotencyKey);
  assert.equal(r2.auditId, r1.auditId);

  audit.restore();

  const r3 = (await detect({ assetId: 'valve-3', metric: 'flow', threshold: 80 })).json();
  const r4 = (await detect({ assetId: 'valve-3', metric: 'flow', threshold: 80 })).json();
  assert.equal(r3.state, 'committed');
  assert.equal(r4.state, 'committed');
  assert.equal(r3.incident.id, r4.incident.id);
  assert.equal(r3.auditId, r4.auditId);

  const entries = (await app.inject({ method: 'GET', url: `/audit?entityId=${r3.incident.id}` })).json();
  assert.equal(entries.length, 1);

  // All anomaly audit facts system-wide: exactly one for this asset.
  const all = (await app.inject({ method: 'GET', url: '/audit' })).json() as Array<{ action: string }>;
  assert.equal(all.filter((e) => e.action === ACTION).length, 1);

  await app.close();
});

test('explicit idempotency key is reused; conflicting reuse is rejected', async () => {
  const { app, ingest, detect } = await setup();
  await ingest('pump-9', 'temp', 500, 1000);

  const r1 = await detect({ assetId: 'pump-9', metric: 'temp', threshold: 100, idempotencyKey: 'biz-ticket-42' });
  assert.equal(r1.statusCode, 200);
  const first = r1.json();
  assert.equal(first.idempotencyKey, 'biz-ticket-42');

  const r2 = await detect({ assetId: 'pump-9', metric: 'temp', threshold: 100, idempotencyKey: 'biz-ticket-42' });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().incident.id, first.incident.id);

  const conflict = await detect({ assetId: 'pump-9', metric: 'temp', threshold: 999, idempotencyKey: 'biz-ticket-42' });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, 'IDEMPOTENCY_KEY_CONFLICT');

  await app.close();
});

test('no-anomaly detection creates neither incident nor anomaly audit', async () => {
  const { app, ingest, detect } = await setup();
  await ingest('sensor-1', 'temp', 42, 1000);

  const res = await detect({ assetId: 'sensor-1', metric: 'temp', threshold: 100 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.state, 'no_anomaly');
  assert.equal(body.incident, null);
  assert.equal(body.retryable, false);

  const status = await app.inject({ method: 'GET', url: `/anomalies/status/${body.idempotencyKey}` });
  assert.equal(status.json().state, 'no_anomaly');

  const all = (await app.inject({ method: 'GET', url: '/audit' })).json() as Array<{ action: string }>;
  assert.equal(all.filter((e) => e.action === ACTION).length, 0);

  // Unknown key is a clean 404.
  const missing = await app.inject({ method: 'GET', url: '/anomalies/status/does-not-exist' });
  assert.equal(missing.statusCode, 404);

  await app.close();
});
