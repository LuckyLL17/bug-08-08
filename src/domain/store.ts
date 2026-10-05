import { Asset, AuditEntry, DetectionOperation, DomainEvent, Incident, Telemetry, TopologyVersion, WorkOrder } from './types';

/**
 * In-memory state. All critical multi-write flows (e.g. anomaly detection +
 * incident + audit) are coordinated by services through a single resource
 * group so that a partial write can be rolled back.
 */
export class TwinStore {
  assets = new Map<string,Asset>();
  telemetry:Telemetry[]=[];
  events:DomainEvent[]=[];
  incidents=new Map<string,Incident>();
  workOrders=new Map<string,WorkOrder>();
  topology:TopologyVersion[]=[];
  audit=new Map<string,AuditEntry>();
  /** Index: `${action}:${entityId}` -> audit entry id, enforces write-once audit facts. */
  auditIndex=new Map<string,string>();
  /** Idempotency table for anomaly-detection operations, keyed by business identity. */
  detections=new Map<string,DetectionOperation>();
}
