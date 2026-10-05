import { newId } from '../core/id';
import { stableHash } from '../core/hash';
import { TwinStore } from '../domain/store';
import { AuditEntry } from '../domain/types';

export class AuditUnavailableError extends Error {
  constructor(public cause?: unknown) {
    super('audit storage unavailable');
    this.name = 'AuditUnavailableError';
  }
}

export interface AuditRecord {
  id?: string;
  action: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  at?: number;
}

export class AuditService {
  /** When > 0 the next N record() calls fail; recovery is driven by tests/ops via restore(). */
  private failingCalls = 0;
  private down = false;

  constructor(private store: TwinStore) {}

  /** Simulate transient audit-storage outage: all writes fail until restore(). */
  fail(n?: number) {
    if (typeof n === 'number') this.failingCalls = n;
    else this.down = true;
  }

  restore() {
    this.down = false;
    this.failingCalls = 0;
  }

  get available() {
    return !this.down && this.failingCalls === 0;
  }

  /**
   * Idempotent, write-once audit append keyed by (action, entityId).
   * Re-recording the same fact returns the existing entry instead of duplicating it.
   */
  record(record: AuditRecord): AuditEntry {
    if (this.down || this.failingCalls > 0) {
      if (this.failingCalls > 0) this.failingCalls -= 1;
      throw new AuditUnavailableError('simulated audit storage outage');
    }
    const key = `${record.action}:${record.entityId}`;
    const existingId = this.store.auditIndex.get(key);
    if (existingId) {
      const existing = this.store.audit.get(existingId)!;
      return existing;
    }
    const entry: AuditEntry = {
      id: record.id ?? newId('audit'),
      action: record.action,
      entityId: record.entityId,
      at: record.at ?? Date.now(),
      metadata: record.metadata ? { ...record.metadata } : {},
    };
    this.store.audit.set(entry.id, entry);
    this.store.auditIndex.set(key, entry.id);
    return entry;
  }

  /** Deterministic id for an audit fact, so retries reuse the same entry id. */
  static auditId(action: string, entityId: string) {
    return `audit_${stableHash([action, entityId])}`;
  }

  list(entityId?: string) {
    const all = [...this.store.audit.values()].sort((a, b) => a.at - b.at);
    return entityId ? all.filter((e) => e.entityId === entityId) : all;
  }
}
