import { AuditUnavailableError, DetectionNotFoundError } from '../core/errors';
import { deterministicId, sha256Hex } from '../core/id';
import { TwinStore } from '../domain/store';
import { DetectionRecord, Incident } from '../domain/types';
import { AuditService } from './audit-service';

export interface DetectResult { detection: DetectionRecord; incident: Incident; reused: boolean }
export type MaybeDetectResult = DetectResult | null;

const AUDIT_ACTION = 'anomaly.detect';

/**
 * 异常检测编排：以 detectionKey 为业务标识，保证
 *   检测事实 / incident 状态变更 / 审计事实 成组落地。
 *
 * 分组原子边界：
 *  1) 先暂存检测事务（awaiting_audit）与 incident（未审计、不可派工）；
 *  2) 再以确定性 ID 幂等写审计；
 *  3) 审计成功后事务转 committed，incident 生效。
 * 审计不可用时停在 awaiting_audit —— 明确的可重试中间状态，可随时安全重试。
 */
export class AnomalyService {
  constructor(private store:TwinStore, private audit:AuditService){}

  detect(assetId:string, metric:string, threshold:number, detectionKey?:string):MaybeDetectResult {
    const abnormal = this.abnormalSamples(assetId, metric, threshold);
    if(!abnormal.length) return null;

    const detectedAt = abnormal[abnormal.length-1].observedAt;
    const evidence = abnormal.map(s=>`${s.metric}=${s.value}${s.unit}@${s.observedAt}`);
    const key = detectionKey ?? this.fingerprint(assetId, metric, threshold, detectedAt, evidence);

    const existing = this.store.detections.get(key);
    if(existing){
      // 重复检测复用原业务标识；若仍处于未决中间状态则顺带驱动一次恢复
      if(existing.state !== 'committed') this.commitAudit(existing);
      return { detection: existing, incident: this.store.incidents.get(existing.incidentId)!, reused:true };
    }

    const now = Date.now();
    const incident:Incident = {
      id: deterministicId('inc', key),
      severity: abnormal.some(s=>Math.abs(s.value)>=threshold*2) ? 'critical' : 'high',
      status:'open', assetIds:[assetId], detectedAt,
      evidence,
    };
    const detection:DetectionRecord = {
      detectionKey:key, state:'awaiting_audit', incidentId:incident.id,
      assetId:assetId, metric, threshold, detectedAt, evidence,
      attempts:0, createdAt:now, updatedAt:now,
    };
    // 阶段一：业务事实 + incident 作为未决事务暂存（同一逻辑工作单元）
    this.store.incidents.set(incident.id, incident);
    this.store.detections.set(key, detection);

    // 阶段二：审计事实落地（幂等），成功后成组提交；
    // 审计不可用时抛出的错误已由 commitAudit 附带 detectionKey/incidentId
    this.commitAudit(detection);

    return { detection, incident, reused:false };
  }

  /** 恢复处于 awaiting_audit 的检测事务；已提交则原样返回。 */
  retry(detectionKey:string):DetectResult {
    const detection = this.store.detections.get(detectionKey);
    if(!detection) throw new DetectionNotFoundError(detectionKey);
    if(detection.state==='committed') return { detection, incident: this.store.incidents.get(detection.incidentId)!, reused:true };
    this.commitAudit(detection);
    return { detection, incident: this.store.incidents.get(detection.incidentId)!, reused:false };
  }

  getDetection(detectionKey:string):DetectionRecord {
    const d = this.store.detections.get(detectionKey);
    if(!d) throw new DetectionNotFoundError(detectionKey);
    return d;
  }

  /** 仅未决（未审计）事务，供运维查询需要恢复的检测。 */
  listPending():DetectionRecord[] {
    return [...this.store.detections.values()].filter(d=>d.state!=='committed');
  }

  private commitAudit(detection:DetectionRecord){
    detection.attempts += 1;
    try {
      const entry = this.audit.record(AUDIT_ACTION, detection.incidentId, {
        detectionKey:detection.detectionKey,
        assetId:detection.assetId, metric:detection.metric, threshold:detection.threshold,
        severity:this.store.incidents.get(detection.incidentId)!.severity,
        evidence:detection.evidence,
      }, { idempotencyKey:`${AUDIT_ACTION}:${detection.detectionKey}` });
      detection.auditId = entry.id;
      detection.state = 'committed';
      detection.lastError = undefined;
      detection.updatedAt = Date.now();
    } catch(err) {
      if(!(err instanceof AuditUnavailableError)) throw err;
      // 审计不可用：保留明确可重试的中间状态与可诊断原因，incident 保持“未审计”
      err.detectionKey = detection.detectionKey;
      err.incidentId = detection.incidentId;
      detection.lastError = err.cause instanceof Error ? err.cause.message : String(err.cause);
      detection.updatedAt = Date.now();
      throw err;
    }
  }

  private abnormalSamples(assetId:string, metric:string, threshold:number){
    const samples = this.store.telemetry
      .filter(t=>t.assetId===assetId && t.metric===metric)
      .sort((a,b)=>a.observedAt-b.observedAt);
    return samples.filter(s=>s.quality!=='bad' && Math.abs(s.value)>=threshold);
  }

  /** 业务指纹：同一资产/指标/阈值下、相同异常证据的检测视为同一业务事实。 */
  private fingerprint(assetId:string, metric:string, threshold:number, detectedAt:number, evidence:string[]){
    return sha256Hex(assetId, metric, threshold, detectedAt, ...evidence);
  }
}
