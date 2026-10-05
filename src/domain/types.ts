export type AssetKind = 'pump' | 'valve' | 'sensor' | 'reactor';
export type AssetStatus = 'healthy' | 'degraded' | 'failed';
export type EventType = 'telemetry' | 'alarm' | 'command' | 'ack';
export interface Asset { id:string; name:string; kind:AssetKind; status:AssetStatus; criticality:number; tags:string[] }
export interface Telemetry { assetId:string; metric:string; value:number; unit:string; observedAt:number; quality:'good'|'suspect'|'bad' }
export interface DomainEvent { id:string; type:EventType; assetId:string; timestamp:number; sequence:number; payload:Record<string, unknown> }
export interface Incident { id:string; severity:'low'|'medium'|'high'|'critical'; status:'open'|'investigating'|'contained'|'resolved'; assetIds:string[]; detectedAt:number; evidence:string[] }
export interface TopologyVersion { version:number; effectiveAt:number; edges:Array<{from:string;to:string;weight:number}> }
export interface WorkOrder { id:string; incidentId:string; state:'draft'|'approved'|'executing'|'completed'|'cancelled'; steps:string[]; compensationRequired:boolean }
export interface AuditEntry { id:string; action:string; entityId:string; at:number; metadata:Record<string,unknown> }

/** Lifecycle of one anomaly-detection business operation. */
export type DetectionState = 'committed' | 'failed' | 'no_anomaly';

export interface DetectionAttempt { at:number; code:string; message:string; phase:'audit'|'detect' }

export interface DetectionOperation {
  /** Business identity: caller-supplied idempotency key, or derived from the detection fingerprint. */
  idempotencyKey: string;
  /** Fingerprint of the request parameters; a reused key with a different fingerprint is a conflict. */
  fingerprint: string;
  state: DetectionState;
  attempts: DetectionAttempt[];
  createdAt: number;
  updatedAt: number;
  /** Deterministic incident / audit ids, reused on every retry. */
  incidentId?: string;
  auditId?: string;
  /** Incident payload reconstructed from the business facts, reused across retries. */
  incidentSnapshot?: Incident;
  errorCode?: string;
  errorMessage?: string;
}
