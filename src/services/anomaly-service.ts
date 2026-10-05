import { stableHash, stableId } from '../core/hash';
import { TwinStore } from '../domain/store';
import { DetectionOperation, Incident } from '../domain/types';
import { AuditService, AuditUnavailableError } from './audit-service';

export interface DetectInput {
  assetId: string;
  metric: string;
  threshold: number;
  /** Caller-supplied business identity; when omitted it is derived deterministically from the anomaly facts. */
  idempotencyKey?: string;
}

export interface DetectResult {
  idempotencyKey: string;
  state: DetectionOperation['state'];
  incident: Incident | null;
  auditId?: string;
  /** Present while the operation is in a retryable intermediate state. */
  retryable: boolean;
  errorCode?: string;
  errorMessage?: string;
  attempts: DetectionOperation['attempts'];
}

const ACTION = 'anomaly.detected';

export class IdempotencyConflictError extends Error {
  constructor(public key: string) {
    super(`idempotency key '${key}' was already used with different detection parameters`);
    this.name = 'IdempotencyConflictError';
  }
}

export class AnomalyService {
  constructor(private store: TwinStore, private audit: AuditService) {}

  /**
   * Detection is processed as one atomic business operation:
   *
   *   business fact (anomaly evidence)
   *     -> audit fact (write-once, deterministic id)
   *       -> state change (incident, deterministic id)
   *
   * The audit fact is written first, so an incident can never exist without
   * its audit evidence. Every step is keyed by the same business identity;
   * retries reuse the incident/audit ids and never create duplicates. A
   * failure at any step leaves the operation in an explicit 'failed' state
   * with a diagnostic attempt record, ready for retry after recovery.
   */
  detect(input: DetectInput): DetectResult {
    const facts = this.evaluate(input.assetId, input.metric, input.threshold);

    // No anomaly -> no business fact, nothing to audit. Still remember the
    // request so duplicate detections are answered consistently.
    if (!facts) {
      const key = input.idempotencyKey ?? this.deriveKey(input);
      const op = this.store.detections.get(key);
      if (op && op.fingerprint !== this.fingerprintOf(input, null)) throw new IdempotencyConflictError(key);
      const settled = op ?? this.register(key, input, null);
      if (settled.state !== 'no_anomaly') throw new IdempotencyConflictError(key);
      return this.toResult(settled, null);
    }

    const key = input.idempotencyKey ?? facts.key;
    const fingerprint = this.fingerprintOf(input, facts.evidence);

    let op = this.store.detections.get(key);
    if (op) {
      if (op.fingerprint !== fingerprint) throw new IdempotencyConflictError(key);
      // Already completed: replay the committed result, no side effects.
      if (op.state === 'committed') return this.toResult(op, this.store.incidents.get(op.incidentId!) ?? null);
    } else {
      op = this.register(key, input, facts.evidence);
    }

    const incidentId = op.incidentId ?? stableId('inc', [key]);
    const auditId = op.auditId ?? AuditService.auditId(ACTION, incidentId);
    op.incidentId = incidentId;
    op.auditId = auditId;
    op.incidentSnapshot = op.incidentSnapshot ?? facts.incident;

    // Step 1: audit fact first. Failure here means no incident is ever written.
    if (!this.store.audit.has(auditId)) {
      try {
        this.audit.record({
          id: auditId,
          action: ACTION,
          entityId: incidentId,
          at: facts.incident.detectedAt,
          metadata: {
            idempotencyKey: key,
            assetId: input.assetId,
            metric: input.metric,
            threshold: input.threshold,
            severity: facts.incident.severity,
            evidence: facts.incident.evidence,
          },
        });
      } catch (e) {
        return this.fail(op, 'audit', e);
      }
    }

    // Step 2: state change (incident). If it ever fails, the audit fact
    // remains as a legitimate record and the operation stays retryable; the
    // next retry reuses the same audit entry and writes the incident.
    if (!this.store.incidents.has(incidentId)) {
      try {
        this.store.incidents.set(incidentId, { ...op.incidentSnapshot!, id: incidentId });
      } catch (e) {
        return this.fail(op, 'detect', e);
      }
    }

    op.state = 'committed';
    op.errorCode = undefined;
    op.errorMessage = undefined;
    op.updatedAt = Date.now();
    return this.toResult(op, this.store.incidents.get(incidentId)!);
  }

  status(idempotencyKey: string): DetectResult | null {
    const op = this.store.detections.get(idempotencyKey);
    if (!op) return null;
    const incident = op.incidentId ? this.store.incidents.get(op.incidentId) ?? null : null;
    return this.toResult(op, incident ?? null);
  }

  // ---- internals -----------------------------------------------------------

  private evaluate(assetId: string, metric: string, threshold: number) {
    const samples = this.store.telemetry
      .filter((t) => t.assetId === assetId && t.metric === metric)
      .sort((a, b) => a.observedAt - b.observedAt);
    const abnormal = samples.filter((s) => s.quality !== 'bad' && Math.abs(s.value) >= threshold);
    if (!abnormal.length) return null;
    const last = abnormal[abnormal.length - 1];
    const evidence = abnormal.map((s) => `${s.metric}=${s.value}${s.unit}@${s.observedAt}`);
    const incident: Incident = {
      id: '', // assigned deterministically by the caller
      severity: abnormal.some((s) => Math.abs(s.value) >= threshold * 2) ? 'critical' : 'high',
      status: 'open',
      assetIds: [assetId],
      detectedAt: last.observedAt,
      evidence,
    };
    const key = this.deriveKey({ assetId, metric, threshold }, evidence);
    return { evidence, incident, key };
  }

  private deriveKey(input: DetectInput, evidence?: string[]) {
    // Key derived from the business facts: same asset/metric/threshold and the
    // same evidence window always identifies the same detection.
    return stableId('det', [input.assetId, input.metric, input.threshold, (evidence ?? []).join(',')]);
  }

  private fingerprintOf(input: DetectInput, evidence: string[] | null) {
    return stableHash([input.assetId, input.metric, input.threshold, (evidence ?? []).join(',')]);
  }

  private register(key: string, input: DetectInput, evidence: string[] | null): DetectionOperation {
    const now = Date.now();
    const op: DetectionOperation = {
      idempotencyKey: key,
      fingerprint: this.fingerprintOf(input, evidence),
      state: evidence ? 'failed' : 'no_anomaly',
      attempts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.store.detections.set(key, op);
    return op;
  }

  private fail(op: DetectionOperation, phase: 'audit' | 'detect', e: unknown): DetectResult {
    const code = e instanceof AuditUnavailableError ? 'AUDIT_UNAVAILABLE' : 'INCIDENT_WRITE_FAILED';
    const message = e instanceof Error ? e.message : String(e);
    op.state = 'failed';
    op.errorCode = code;
    op.errorMessage = message;
    op.attempts.push({ at: Date.now(), code, message, phase });
    op.updatedAt = Date.now();
    return this.toResult(op, null);
  }

  private toResult(op: DetectionOperation, incident: Incident | null): DetectResult {
    return {
      idempotencyKey: op.idempotencyKey,
      state: op.state,
      incident,
      auditId: op.auditId,
      retryable: op.state === 'failed',
      errorCode: op.errorCode,
      errorMessage: op.errorMessage,
      attempts: op.attempts,
    };
  }
}
