import { FastifyInstance } from 'fastify';
import { TwinStore } from '../domain/store';
import { TelemetryService } from '../services/telemetry-service';
import { AnomalyService } from '../services/anomaly-service';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';
import { WorkflowService } from '../services/workflow-service';
import { AuditService } from '../services/audit-service';
import { AuditUnavailableError, DetectionNotFoundError } from '../core/errors';

export interface RouteDeps { store?:TwinStore; audit?:AuditService; anomalies?:AnomalyService }

export function registerRoutes(app:FastifyInstance, deps:TwinStore|RouteDeps=new TwinStore()){
  // 兼容直接传 TwinStore 的调用
  const store = deps instanceof TwinStore ? deps : (deps.store ?? new TwinStore());
  const audit = 'audit' in deps && deps.audit ? deps.audit : new AuditService();
  const telemetry=new TelemetryService(store);
  const anomalies = 'anomalies' in deps && deps.anomalies ? deps.anomalies! : new AnomalyService(store,audit);
  const topology=new TopologyService(store);
  const causes=new RootCauseService(store,topology);
  const workflows=new WorkflowService(store);

  app.get('/health',async()=>({ok:true}));

  app.post('/topology',async(req,res)=>{try{return topology.publish(req.body as any)}catch(e:any){return res.code(400).send({code:e.code,message:e.message})}});

  app.post('/telemetry',async(req)=>{const e=telemetry.ingest(req.body as any);audit.record('telemetry.ingest',e.id,{assetId:e.assetId});return e});

  app.get('/telemetry/replay',async(req)=>{const q=req.query as any;return telemetry.replay(Number(q.from),Number(q.to))});

  // 异常检测：成功(committed) -> 201；审计暂不可用(awaiting_audit) -> 202 可重试
  app.post('/anomalies/detect',async(req,res)=>{
    const b=req.body as any;
    try{
      const r=anomalies.detect(b.assetId,b.metric,Number(b.threshold),b.detectionKey);
      if(!r) return {detected:false};
      const body={detected:true, reused:r.reused, incident:r.incident, detectionKey:r.detection.detectionKey, auditId:r.detection.auditId, state:r.detection.state};
      return r.detection.state==='committed' ? res.code(r.reused?200:201).send(body) : res.code(202).send(body);
    }catch(e:any){
      if(e instanceof AuditUnavailableError){
        const key=e.detectionKey;
        const pending=key ? anomalies.getDetection(key) : undefined;
        return res.code(202).send({detected:true,state:'awaiting_audit',retryable:true,
          message:'incident staged but audit unavailable; retry with detectionKey',
          detectionKey:key, incidentId:e.incidentId ?? pending?.incidentId,
          attempts:pending?.attempts, lastError:pending?.lastError});
      }
      throw e;
    }
  });

  // 恢复重试：复用原业务标识，不产生重复 incident / 审计
  app.post('/anomalies/detections/:key/retry',async(req,res)=>{
    try{
      const r=anomalies.retry((req.params as any).key);
      return res.code(r.reused?200:201).send({detected:true,reused:r.reused,incident:r.incident,detectionKey:r.detection.detectionKey,auditId:r.detection.auditId,state:r.detection.state});
    }catch(e:any){
      if(e instanceof DetectionNotFoundError) return res.code(404).send({code:'DETECTION_NOT_FOUND',message:e.message,detectionKey:e.detectionKey});
      if(e instanceof AuditUnavailableError){
        const d=anomalies.getDetection((req.params as any).key);
        return res.code(202).send({state:'awaiting_audit',retryable:true,detectionKey:d.detectionKey,attempts:d.attempts,lastError:d.lastError});
      }
      throw e;
    }
  });

  // 检测事务状态查询（运维诊断）
  app.get('/anomalies/detections/:key',async(req,res)=>{
    try{ return anomalies.getDetection((req.params as any).key) }
    catch(e:any){
      if(e instanceof DetectionNotFoundError) return res.code(404).send({code:'DETECTION_NOT_FOUND',message:e.message,detectionKey:e.detectionKey});
      throw e;
    }
  });

  app.get('/anomalies/pending',async()=>({pending:anomalies.listPending()}));

  app.get('/incidents/:id/root-cause',async(req,res)=>{try{return causes.analyze((req.params as any).id)}catch(e:any){return res.code(404).send({message:e.message})}});

  app.post('/work-orders',async(req,res)=>{try{return workflows.create((req.body as any).incidentId,(req.body as any).steps||[])}catch(e:any){return res.code(400).send({code:e.code,message:e.message})}});

  app.post('/work-orders/:id/transition',async(req,res)=>{try{return workflows.transition((req.params as any).id,(req.body as any).state)}catch(e:any){return res.code(400).send({code:e.code,message:e.message})}});

  app.get('/audit',async(req)=>audit.list((req.query as any).entityId));

  // 暴露共享实例，便于测试中注入故障（测试也可直接依赖注入）
  (app as any).auditService=audit; (app as any).anomalyService=anomalies; (app as any).twinStore=store;
}
