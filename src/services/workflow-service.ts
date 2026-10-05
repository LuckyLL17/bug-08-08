import { assertOrThrow } from '../core/errors';
import { newId } from '../core/id';
import { TwinStore } from '../domain/store';
import { WorkOrder } from '../domain/types';
const transitions:Record<WorkOrder['state'],WorkOrder['state'][]>= {draft:['approved','cancelled'],approved:['executing','cancelled'],executing:['completed','cancelled'],completed:[],cancelled:[]};
export class WorkflowService {
 constructor(private store:TwinStore){}
 create(incidentId:string,steps:string[]){
  assertOrThrow(this.store.incidents.has(incidentId),'INCIDENT_NOT_FOUND','incident not found');
  // 只有审计已落地（检测事务 committed）的 incident 才能派工，杜绝“无审计依据的 incident”进入业务闭环
  const audited=[...this.store.detections.values()].some(d=>d.incidentId===incidentId&&d.state==='committed');
  assertOrThrow(audited,'INCIDENT_NOT_AUDITED','incident has no committed audit record; detection is pending or missing audit');
  const w:WorkOrder={id:newId('wo'),incidentId,state:'draft',steps:[...steps],compensationRequired:false};
  this.store.workOrders.set(w.id,w);
  return w;
 }
 transition(id:string,next:WorkOrder['state']){
  const w=this.store.workOrders.get(id);
  assertOrThrow(!!w,'WORK_ORDER_NOT_FOUND','work order not found');
  const wo=w!;
  assertOrThrow(transitions[wo.state].includes(next),'INVALID_TRANSITION',`${wo.state} -> ${next}`);
  wo.state=next;return wo;
 }
}
