import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../routes/app-routes';
import { TwinStore } from '../domain/store';
import { AuditService } from '../services/audit-service';
import { AnomalyService } from '../services/anomaly-service';
import { AuditUnavailableError } from '../core/errors';

function seedTelemetry(store: TwinStore){
  store.telemetry.push(
    { assetId:'pump-1', metric:'rpm', value:1000, unit:'rpm', observedAt:1000, quality:'good' },
    { assetId:'pump-1', metric:'rpm', value:3000, unit:'rpm', observedAt:2000, quality:'good' },
    { assetId:'pump-1', metric:'rpm', value:3500, unit:'rpm', observedAt:3000, quality:'good' },
  );
}

async function buildHarness(){
  const store = new TwinStore();
  seedTelemetry(store);
  const audit = new AuditService();
  const anomalies = new AnomalyService(store, audit);
  const app = Fastify({logger:false});
  registerRoutes(app, { store, audit, anomalies });
  await app.ready();
  return { app, store, audit, anomalies };
}

test('正常成功路径：检测 -> incident 与审计成组落地，状态 committed', async()=>{
  const { app, store, audit } = await buildHarness();

  const res = await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'rpm',threshold:2000}});
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.state, 'committed');
  assert.ok(body.incident?.id.startsWith('inc_'));
  assert.ok(body.detectionKey);
  assert.ok(body.auditId);

  // incident 已入库且与检测事务/审计一致
  const incident = store.incidents.get(body.incident.id);
  assert.ok(incident);
  assert.equal(incident!.id, body.incident.id);
  const audits = audit.list(body.incident.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'anomaly.detect');
  assert.equal(audits[0].metadata.detectionKey, body.detectionKey);

  // committed incident 允许派工
  const wo = await app.inject({method:'POST',url:'/work-orders',payload:{incidentId:body.incident.id,steps:['inspect']}});
  assert.equal(wo.statusCode, 200);

  // 无异常证据时不产生 incident / 审计
  const none = await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'rpm',threshold:9999}});
  assert.equal(none.statusCode, 200);
  assert.deepEqual(none.json(), {detected:false});
  assert.equal(audit.entries.length, 1);

  await app.close();
});

test('注入审计失败：incident 暂存为 awaiting_audit 且无审计记录，派工被拒绝', async()=>{
  const { app, store, audit } = await buildHarness();
  audit.injectWriteFailure('simulated audit disk full');

  const res = await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'rpm',threshold:2000}});
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.state, 'awaiting_audit');
  assert.equal(body.retryable, true);
  assert.ok(body.detectionKey, '必须返回可用于重试的业务标识');
  assert.ok(body.lastError?.includes('simulated audit disk full'), '必须保留可诊断的失败原因');
  assert.equal(body.attempts, 1);

  // incident 存在（业务事实已暂存），但没有任何审计事实
  assert.ok(store.incidents.has(body.incidentId));
  assert.equal(audit.list(body.incidentId).length, 0);

  // 无审计依据的 incident 不允许派工
  const wo = await app.inject({method:'POST',url:'/work-orders',payload:{incidentId:body.incidentId,steps:['inspect']}});
  assert.equal(wo.statusCode, 400);
  assert.equal(wo.json().code, 'INCIDENT_NOT_AUDITED');

  // pending 查询能看到该中间状态
  const pend = await app.inject({method:'GET',url:'/anomalies/pending'});
  assert.equal(pend.json().pending.length, 1);
  assert.equal(pend.json().pending[0].detectionKey, body.detectionKey);

  await app.close();
});

test('恢复后重试：复用原业务标识，只提交一次 incident 与审计', async()=>{
  const { app, store, audit } = await buildHarness();
  audit.injectWriteFailure('transient outage');

  const failed = (await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'rpm',threshold:2000}})).json();
  const incidentId = failed.incidentId;
  const detectionKey = failed.detectionKey;
  assert.equal(audit.list(incidentId).length, 0);

  // 审计恢复
  audit.resumeWrites();

  const retry = await app.inject({method:'POST',url:`/anomalies/detections/${detectionKey}/retry`});
  assert.equal(retry.statusCode, 201);
  const r = retry.json();
  assert.equal(r.state, 'committed');
  assert.equal(r.incident.id, incidentId, 'incident ID 必须复用');
  assert.equal(r.detectionKey, detectionKey, '业务标识必须复用');

  // 无重复 incident / 无重复审计 / 无重复检测事务
  assert.equal(store.incidents.size, 1);
  assert.equal(store.detections.size, 1);
  assert.equal(audit.list(incidentId).length, 1);
  assert.equal(audit.entries.length, 1);

  // 再次重试为幂等返回
  const retry2 = await app.inject({method:'POST',url:`/anomalies/detections/${detectionKey}/retry`});
  assert.equal(retry2.statusCode, 200);
  assert.equal(retry2.json().reused, true);
  assert.equal(audit.entries.length, 1);

  // 恢复后可以派工
  const wo = await app.inject({method:'POST',url:'/work-orders',payload:{incidentId,steps:['go']}});
  assert.equal(wo.statusCode, 200);

  await app.close();
});

test('失败 N 次后自动恢复 + 状态查询：重试期间可诊断，恢复后 committed', async()=>{
  const { app, audit } = await buildHarness();
  audit.injectWriteFailure('two blips', 2); // 前两次写失败，第三次成功

  const first = await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'rpm',threshold:2000}});
  assert.equal(first.statusCode, 202);
  const { detectionKey, incidentId } = first.json();

  const r1 = await app.inject({method:'POST',url:`/anomalies/detections/${detectionKey}/retry`});
  assert.equal(r1.statusCode, 202);
  assert.match(r1.json().lastError, /two blips/);

  const status = await app.inject({method:'GET',url:`/anomalies/detections/${detectionKey}`});
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().state, 'awaiting_audit');
  assert.equal(status.json().attempts, 2);
  assert.equal(status.json().incidentId, incidentId);

  const r2 = await app.inject({method:'POST',url:`/anomalies/detections/${detectionKey}/retry`});
  assert.equal(r2.statusCode, 201);
  assert.equal(r2.json().state, 'committed');
  assert.equal(audit.entries.length, 1);

  const status2 = await app.inject({method:'GET',url:`/anomalies/detections/${detectionKey}`});
  assert.equal(status2.json().state, 'committed');
  assert.equal(status2.json().lastError, undefined);

  await app.close();
});

test('重复检测（故障期间与恢复后）：同业务事实不产生重复 incident / 审计', async()=>{
  const { app, store, audit } = await buildHarness();
  audit.injectWriteFailure('outage');

  const d1 = (await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'rpm',threshold:2000}})).json();

  // 故障期间再次发起相同检测：复用同一业务标识，仍是 202
  const d2 = await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'rpm',threshold:2000}});
  assert.equal(d2.statusCode, 202);
  const b2 = d2.json();
  assert.equal(b2.detectionKey, d1.detectionKey);
  assert.equal(b2.incidentId, d1.incidentId);
  assert.equal(store.incidents.size, 1);
  assert.equal(store.detections.size, 1);
  assert.equal(audit.entries.length, 0);

  // 恢复后再次发起相同检测：驱动提交并复用
  audit.resumeWrites();
  const d3 = await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'rpm',threshold:2000}});
  assert.equal(d3.statusCode, 200);
  assert.equal(d3.json().reused, true);
  assert.equal(d3.json().state, 'committed');
  assert.equal(d3.json().incident.id, d1.incidentId);
  assert.equal(store.incidents.size, 1);
  assert.equal(store.detections.size, 1);
  assert.equal(audit.entries.length, 1);

  // 再重复一次：完全幂等
  const d4 = await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'rpm',threshold:2000}});
  assert.equal(d4.statusCode, 200);
  assert.equal(d4.json().auditId, d3.json().auditId);
  assert.equal(audit.entries.length, 1);

  await app.close();
});

test('显式 detectionKey：不同调用方用相同键也只产生一组事实', async()=>{
  const { app, store, audit } = await buildHarness();
  const payload = {assetId:'pump-1',metric:'rpm',threshold:2000,detectionKey:'client-key-001'};

  audit.injectWriteFailure('once', 1);
  const f = await app.inject({method:'POST',url:'/anomalies/detect',payload});
  assert.equal(f.statusCode, 202);
  audit.resumeWrites();

  const ok = await app.inject({method:'POST',url:'/anomalies/detect',payload});
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().detectionKey, 'client-key-001');
  assert.equal(store.incidents.size, 1);
  assert.equal(audit.entries.length, 1);

  // 未知键重试 -> 404
  const missing = await app.inject({method:'POST',url:'/anomalies/detections/unknown/retry'});
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, 'DETECTION_NOT_FOUND');

  await app.close();
});

test('服务层不变量：审计持续不可用时多次重试不产生孤儿审计/重复 incident，attempts 累加', async()=>{
  const store = new TwinStore();
  seedTelemetry(store);
  const audit = new AuditService();
  const anomalies = new AnomalyService(store, audit);
  audit.injectWriteFailure('persistent');

  assert.throws(()=>anomalies.detect('pump-1','rpm',2000), AuditUnavailableError);
  assert.equal(store.incidents.size, 1);
  assert.equal(audit.entries.length, 0);
  const pending = anomalies.listPending();
  assert.equal(pending.length, 1);

  for(let i=0;i<3;i++) assert.throws(()=>anomalies.retry(pending[0].detectionKey), AuditUnavailableError);
  assert.equal(store.incidents.size, 1);
  assert.equal(audit.entries.length, 0);
  const d = anomalies.getDetection(pending[0].detectionKey);
  assert.equal(d.state, 'awaiting_audit');
  assert.equal(d.attempts, 4, '每次重试都计入尝试次数');
  assert.ok(d.lastError);

  audit.resumeWrites();
  const r = anomalies.retry(pending[0].detectionKey);
  assert.equal(r.detection.state, 'committed');
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].id, r.detection.auditId);
  // 审计幂等键与 incident 绑定
  assert.equal(audit.list(r.incident.id).length, 1);
});
