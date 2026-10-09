/**
 * 可执行操作表（control）：为“启动→推进→完成”的异步操作（如车门开合动画）提供状态机，
 * 并基于 requestId 做幂等记录，供 sceneControl 调用。
 * 对外导出 ControlError 与 Operations。约定：动画状态通过回调 read() 轮询推进；
 * 同一 domain 上新的操作会把旧的置为 superseded；15 秒未完成判为失败（OPERATION_STALLED）。
 */
/** 带错误码与可选明细的控制错误；桥接层会把它转成结构化错误响应。 */
export class ControlError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: unknown = null,
  ) {
    super(message)
  }
}

/** 操作注册表与幂等请求记录：execute 去重，start/tick/get/observe 管理异步操作的生命周期。 */
export class Operations {
  private requests = new Map<string, { fingerprint: string; result: any }>()
  private operations = new Map<string, any>()
  private revision = 0
  get stateRevision() {
    return this.revision
  }

  execute(requestId: string, fingerprint: string, run: () => any) {
    const previous = this.requests.get(requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ControlError('REQUEST_ID_CONFLICT', '同一 requestId 不能用于不同参数。')
      return previous.result
    }
    // Never silently evict an idempotency record and replay a non-idempotent action.
    if (this.requests.size >= 2000)
      throw new ControlError(
        'REQUEST_LIMIT',
        '本页面已达到2000次命令记录上限，请重新加载后发现新会话。',
      )
    const result = run()
    this.requests.set(requestId, { fingerprint, result })
    this.revision++
    return result
  }

  start(
    domain: string,
    target: boolean,
    read: () => { currentFraction: number; target: boolean; blocked: boolean },
    details: any,
  ) {
    for (const op of this.operations.values())
      if (op.domain === domain && op.status === 'running') op.status = 'superseded'
    const op = {
      operationId: crypto.randomUUID(),
      status: 'running',
      domain,
      target,
      observedState: details,
      changed: true,
      createdAt: Date.now(),
      stable: 0,
      read,
    }
    this.operations.set(op.operationId, op)
    return op
  }

  tick() {
    for (const op of this.operations.values()) {
      if (op.status !== 'running') continue
      const state = op.read()
      op.observedState.currentFraction = state.currentFraction
      op.observedState.moving = Math.abs(state.currentFraction - Number(op.target)) > 0.01
      if (state.blocked || state.target !== op.target) op.status = 'superseded'
      // 与目标开度相差超过 0.01（开度比例）即认为仍在运动。
      else if (!op.observedState.moving) {
        // 连续 2 个 tick 稳定才判定完成，避免抖动导致过早结束。
        if (++op.stable >= 2) op.status = 'completed'
      } else op.stable = 0
      // 超过 15 秒仍未完成视为停滞（页面可能被挂起）。
      if (Date.now() - op.createdAt > 15000 && op.status === 'running') {
        op.status = 'failed'
        op.error = { code: 'OPERATION_STALLED', message: '动画未在15秒内完成；页面可能被挂起。' }
      }
      if (op.status !== 'running') this.revision++
    }
  }

  get(id: string) {
    const op = this.operations.get(id)
    if (!op)
      throw new ControlError(
        'OPERATION_NOT_FOUND',
        '找不到此操作，请检查 sceneEpoch 和 operationId。',
      )
    return op
  }
  async observe(op: any, waitMs: number) {
    const end = Date.now() + waitMs
    const stalled = () => {
      if (op.status === 'running' && Date.now() - op.createdAt > 15000) {
        op.status = 'failed'
        op.error = { code: 'OPERATION_STALLED', message: '动画未推进或页面被挂起。' }
        this.revision++
      }
    }
    stalled()
    while (op.status === 'running' && Date.now() < end) {
      // 每 40 毫秒轮询一次操作状态，直到完成或到达等待上限。
      await new Promise((resolve) => setTimeout(resolve, 40))
      stalled()
    }
    const { read, stable, domain, ...result } = op
    return {
      ...result,
      observedState: { ...op.observedState },
      summary: op.status === 'completed' ? '车门已到达目标开度。' : `操作状态：${op.status}`,
    }
  }
}
