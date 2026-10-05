import { FastifyInstance } from 'fastify';
import { TwinStore } from '../domain/store';
import { TelemetryService } from '../services/telemetry-service';
import { AnomalyService, IdempotencyConflictError } from '../services/anomaly-service';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';
import { WorkflowService } from '../services/workflow-service';
import { AuditService } from '../services/audit-service';

export function registerRoutes(app:FastifyInstance,store:TwinStore){
  const telemetry=new TelemetryService(store);
  const audit=new AuditService(store);
  const anomalies=new AnomalyService(store,audit);
  const topology=new TopologyService(store);
  const causes=new RootCauseService(store,topology);
  const workflows=new WorkflowService(store);

  // Test/ops seam: drive the simulated audit-storage outage from outside.
  (app as any).auditService = audit;

  app.get('/health',async()=>({ok:true}));

  app.post('/topology',async(req,res)=>{try{return topology.publish(req.body as any)}catch(e:any){return res.code(400).send({code:e.code,message:e.message})}});

  app.post('/telemetry',async(req)=>{
    const e=telemetry.ingest(req.body as any);
    audit.record({action:'telemetry.ingest',entityId:e.id,metadata:{assetId:e.assetId}});
    return e;
  });

  app.get('/telemetry/replay',async(req)=>{const q=req.query as any;return telemetry.replay(Number(q.from),Number(q.to))});

  app.post('/anomalies/detect',async(req,res)=>{
    const b=req.body as any;
    try{
      const r=anomalies.detect({assetId:b.assetId,metric:b.metric,threshold:Number(b.threshold),idempotencyKey:b.idempotencyKey});
      if(r.retryable) return res.code(503).send({code:r.errorCode,message:r.errorMessage,...r});
      return r;
    }catch(e:any){
      if(e instanceof IdempotencyConflictError) return res.code(409).send({code:'IDEMPOTENCY_KEY_CONFLICT',message:e.message});
      throw e;
    }
  });

  app.get('/anomalies/status/:key',async(req,res)=>{
    const r=anomalies.status((req.params as any).key);
    return r?r:res.code(404).send({code:'DETECTION_NOT_FOUND',message:'unknown idempotency key'});
  });

  app.get('/incidents/:id/root-cause',async(req,res)=>{try{return causes.analyze((req.params as any).id)}catch(e:any){return res.code(404).send({message:e.message})}});

  app.post('/work-orders',async(req,res)=>{try{return workflows.create((req.body as any).incidentId,(req.body as any).steps||[])}catch(e:any){return res.code(400).send({message:e.message})}});

  app.post('/work-orders/:id/transition',async(req,res)=>{try{return workflows.transition((req.params as any).id,(req.body as any).state)}catch(e:any){return res.code(400).send({message:e.message})}});

  app.get('/audit',async(req)=>audit.list((req.query as any).entityId));
}
