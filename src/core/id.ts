import { createHash, randomUUID } from 'node:crypto';
export const newId = (prefix:string) => `${prefix}_${randomUUID()}`;

/**
 * 由业务标识确定性派生 ID：同一业务事实重试时复用，避免重复 incident / 重复审计。
 * 形态保持 `prefix_<hex>`，与随机 ID 兼容且不会碰撞。
 */
export const deterministicId = (prefix:string, ...parts:Array<string|number>) => {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
};

export const sha256Hex = (...parts:Array<string|number>) =>
  createHash('sha256').update(parts.join('|')).digest('hex');
