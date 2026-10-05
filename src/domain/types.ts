export type AssetKind = 'pump' | 'valve' | 'sensor' | 'reactor';
export type AssetStatus = 'healthy' | 'degraded' | 'failed';
export type EventType = 'telemetry' | 'alarm' | 'command' | 'ack';
export interface Asset { id:string; name:string; kind:AssetKind; status:AssetStatus; criticality:number; tags:string[] }
export interface Telemetry { assetId:string; metric:string; value:number; unit:string; observedAt:number; quality:'good'|'suspect'|'bad' }
export interface DomainEvent { id:string; type:EventType; assetId:string; timestamp:number; sequence:number; payload:Record<string, unknown> }
export interface Incident { id:string; severity:'low'|'medium'|'high'|'critical'; status:'open'|'investigating'|'contained'|'resolved'; assetIds:string[]; detectedAt:number; evidence:string[] }
export interface TopologyVersion { version:number; effectiveAt:number; edges:Array<{from:string;to:string;weight:number}> }
export interface WorkOrder { id:string; incidentId:string; state:'draft'|'approved'|'executing'|'completed'|'cancelled'; steps:string[]; compensationRequired:boolean }

/**
 * 异常检测事务：把“检测出的业务事实 + incident 状态变更 + 审计事实”
 * 绑定为同一个业务标识（detectionKey）的分组原子操作。
 *
 * awaiting_audit —— 中间可重试状态：incident 与检测事实已暂存，审计尚未落地。
 *                   运维看到该状态即可重试；此时 incident 不允许派工。
 * committed      —— 审计已落地，incident 成为有效业务事实。
 */
export type DetectionState = 'awaiting_audit' | 'committed';
export interface DetectionRecord {
  detectionKey: string;
  state: DetectionState;
  incidentId: string;
  auditId?: string;
  assetId: string;
  metric: string;
  threshold: number;
  detectedAt: number;
  evidence: string[];
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}
