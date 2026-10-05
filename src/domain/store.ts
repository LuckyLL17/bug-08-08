import { Asset, DetectionRecord, DomainEvent, Incident, Telemetry, TopologyVersion, WorkOrder } from './types';
export class TwinStore {
  assets = new Map<string,Asset>(); telemetry:Telemetry[]=[]; events:DomainEvent[]=[];
  incidents=new Map<string,Incident>(); workOrders=new Map<string,WorkOrder>(); topology:TopologyVersion[]=[];
  /** detectionKey -> 检测事务记录（outbox / 事务状态表） */
  detections=new Map<string,DetectionRecord>();
}
