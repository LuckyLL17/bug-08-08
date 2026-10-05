import { newId, deterministicId } from '../core/id';
import { AuditUnavailableError } from '../core/errors';

export interface AuditEntry { id:string; action:string; entityId:string; at:number; metadata:Record<string,unknown> }

export interface RecordOptions {
  /** 幂等键：相同键的重写返回同一条审计记录，不会产生重复审计。 */
  idempotencyKey?: string;
}

export class AuditService {
  entries:AuditEntry[]=[];
  /** 故障注入开关：开启后写入审计将抛 AuditUnavailableError，模拟审计存储暂时不可用。 */
  private failWrites = false;
  /** 故障注入次数限制：>0 时仅失败前 N 次，用于模拟“失败后恢复”。 */
  private failRemaining = 0;
  private failureReason?: string;

  /**
   * 注入审计写入故障。
   * @param times 失败次数；Infinity 表示持续失败（直到 resumeWrites）
   */
  injectWriteFailure(reason='injected audit outage', times=Infinity){
    this.failWrites=true;
    this.failRemaining=times;
    this.failureReason=reason;
  }
  /** 恢复审计存储。 */
  resumeWrites(){ this.failWrites=false; this.failRemaining=0; this.failureReason=undefined; }
  isHealthy(){ return !this.failWrites; }

  record(action:string, entityId:string, metadata:Record<string,unknown>={}, options:RecordOptions={}):AuditEntry{
    if(this.failWrites){
      const reason=this.failureReason ?? 'audit store unavailable';
      if(this.failRemaining!==Infinity){
        if(this.failRemaining<=0){ this.resumeWrites(); }
        else { this.failRemaining-=1; if(this.failRemaining===0) this.resumeWrites(); throw new AuditUnavailableError(reason); }
      } else {
        throw new AuditUnavailableError(reason);
      }
    }
    const id = options.idempotencyKey ? deterministicId('audit', options.idempotencyKey) : newId('audit');
    const existing=this.entries.find(e=>e.id===id);
    if(existing) return existing; // 重试复用：不产生重复审计
    const e:AuditEntry={id,action,entityId,at:Date.now(),metadata};
    this.entries.push(e);
    return e;
  }

  list(entityId?:string){return entityId?this.entries.filter(e=>e.entityId===entityId):[...this.entries];}
}
