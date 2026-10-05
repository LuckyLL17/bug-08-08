# 工业过程数字孪生与异常根因推理服务

纯后端 Node.js + TypeScript + Fastify 项目，使用内存状态运行，不依赖 Docker、数据库或消息队列。

## 运行

```bash
npm install
npm test
npm start
```

## 业务闭环

设备拓扑版本 → 遥测接入 → 时间序列重放 → 阈值异常检测 → 拓扑影响分析 → 根因候选 → 工单状态机 → 审计追踪。

关键不变量：拓扑版本连续且按生效时间选择；遥测事件按业务时间和序列号重放；工单只能沿合法状态机迁移；所有重要操作产生审计记录。

## 异常检测的成组落地（检测事务）

`POST /anomalies/detect` 以业务标识 `detectionKey`（默认由 资产/指标/阈值/异常证据 指纹生成，也可由调用方显式传入）把三件事绑定为一个事务：

1. 检测出的业务事实 + incident 暂存为 `awaiting_audit`（未审计的 incident 不允许派工）；
2. 以确定性 ID 幂等写审计（`anomaly.detect`，含 detectionKey）；
3. 审计成功后事务转 `committed`，incident 生效。

审计存储不可用时停在 `awaiting_audit`：返回 `202` 与 `detectionKey/incidentId/attempts/lastError`，是明确可重试的中间状态，不会留下“无审计依据的 incident”。

- `POST /anomalies/detections/:key/retry` —— 恢复重试，复用原业务标识，不产生重复 incident/审计
- `GET  /anomalies/detections/:key` —— 检测事务状态查询
- `GET  /anomalies/pending` —— 所有未决检测（运维扫描恢复）

incident ID 与审计 ID 均由 `detectionKey` 确定性派生，重复检测/重试天然幂等。
