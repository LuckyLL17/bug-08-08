export class DomainError extends Error { constructor(public code:string,message:string){super(message)} }
export const assertOrThrow=(condition:boolean,code:string,message:string)=>{if(!condition) throw new DomainError(code,message)};

/** 审计存储暂时不可用：业务事实已暂存，调用方可安全重试。 */
export class AuditUnavailableError extends Error {
  /** 由编排层填充：失败所属的检测业务标识与暂存 incident，便于精确重试。 */
  detectionKey?: string;
  incidentId?: string;
  constructor(public readonly cause: unknown) {
    super('audit store unavailable');
    this.name = 'AuditUnavailableError';
  }
}

/** 请求恢复一个不存在的检测事务。 */
export class DetectionNotFoundError extends Error {
  constructor(public readonly detectionKey: string) {
    super(`detection not found: ${detectionKey}`);
    this.name = 'DetectionNotFoundError';
  }
}
