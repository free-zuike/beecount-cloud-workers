/**
 * 对齐上游 `snapshot_mutator._new_sync_id`：
 *
 *   def _new_sync_id(prefix: str) -> str:
 *       return f"{prefix}_{uuid4().hex[:12]}"
 *
 * 前缀：交易 tx、账户 acc、分类 cat、标签 tag、预算 bgt。
 * 上游还有一个 legacy 正则 `^(tx|acc|cat|tag)_(\d+)_([A-Za-z0-9]+)$`，
 * 说明历史上换过格式；库里新旧格式并存是被接受的。
 *
 * 注意：只用于**对外暴露的 sync_id**。内部主键（users/devices/tokens/附件等）
 * 上游也是 uuid，这里不动。
 */
export function newSyncId(prefix: 'tx' | 'acc' | 'cat' | 'tag' | 'bgt'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
