// 测试 shim：模拟 Cloudflare Workers 的 `cloudflare:workers` 模块。
// 生产运行时是 Workers 专属；vitest(node) 无法解析。这里提供最小可用基类，
// BeeCountDO / BackupWorkflow 继承后能正常构造，但不执行 DO/Workflow 专属逻辑。
export class DurableObject<Env = unknown> {
  constructor(
    protected state: unknown,
    protected env: Env,
  ) {}
}

// Workflow：run 在不触发的情况下不会被调用，基类仅需可继承
export class WorkflowEntrypoint<Env extends { Bindings?: unknown } = { Bindings: unknown }, Params = unknown> {
  protected env: Env;
  constructor(env: Env) {
    this.env = env;
  }
}

export type WorkflowEvent<Params = unknown> = unknown & {
  payload: Params;
};

export type WorkflowStep = (
  name: string,
  callback: () => Promise<unknown>,
) => Promise<unknown>;

export default { DurableObject, WorkflowEntrypoint };