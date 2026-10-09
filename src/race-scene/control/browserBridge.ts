/**
 * 浏览器侧 MCP 桥接（control）：把页面内的场景控制会话接到本机 MCP 服务的 WebSocket 上，
 * 通过 URL 参数 mcp=1 与一次性配对令牌（放在 URL fragment 中）开启。
 * 对外导出 connectSceneBridge。令牌只从 fragment 读取并存入 sessionStorage、随后从地址栏抹掉，
 * 绝不写日志；断线后除“配对失败(1008)”外会自动重连。
 */
import type { createSceneControl } from './sceneControl'

// Capture pairing before the page's settings initialization rewrites its URL.
const initialQuery = new URLSearchParams(location.search)
const initialFragment = new URLSearchParams(location.hash.slice(1))
if (initialQuery.get('mcp') === '1' && initialFragment.has('mcpToken')) {
  sessionStorage.setItem('sceneMcpToken', initialFragment.get('mcpToken')!)
  initialFragment.delete('mcpToken')
  history.replaceState(
    null,
    '',
    location.pathname +
      location.search +
      (initialFragment.size ? '#' + initialFragment.toString() : ''),
  )
}

/** Opt-in bridge. Pairing token is accepted from the URL fragment, never logged. */
export function connectSceneBridge(control: ReturnType<typeof createSceneControl>) {
  const query = new URLSearchParams(location.search)
  if (query.get('mcp') !== '1') return
  const fragment = new URLSearchParams(location.hash.slice(1))
  const supplied = fragment.get('mcpToken')
  if (supplied) {
    sessionStorage.setItem('sceneMcpToken', supplied)
    fragment.delete('mcpToken')
    history.replaceState(
      null,
      '',
      location.pathname + location.search + (fragment.size ? '#' + fragment.toString() : ''),
    )
  }
  const token = sessionStorage.getItem('sceneMcpToken')
  if (!token) {
    console.warn('[scene-mcp] 缺少配对凭证，请使用 MCP 服务输出的配对链接。')
    return
  }
  // 默认端口 5188；非整数或落在特权端口段时直接放弃连接。
  const port = Number(query.get('mcpPort') ?? 5188)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return
  let socket: WebSocket | null = null,
    closed = false,
    retry: ReturnType<typeof setTimeout> | undefined
  const badge = document.createElement('div')
  badge.id = 'scene-mcp-status'
  badge.style.cssText =
    'position:fixed;left:20px;bottom:45px;z-index:20;padding:6px 10px;border-radius:6px;background:#18343cdd;color:white;font:12px sans-serif;pointer-events:none'
  document.body.appendChild(badge)
  const connect = () => {
    badge.textContent = 'MCP 正在连接'
    socket = new WebSocket(`ws://127.0.0.1:${port}/scene`)
    socket.onopen = () =>
      socket!.send(
        JSON.stringify({
          type: 'hello',
          token,
          sessionId: control.sessionId,
          sceneEpoch: control.sceneEpoch,
          title: document.title,
        }),
      )
    socket.onmessage = async (event) => {
      let message: any
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === 'paired') {
        badge.textContent = 'MCP 已连接'
        return
      }
      if (message.type === 'ping') {
        socket?.send(JSON.stringify({ type: 'heartbeat', ready: control.state().ready }))
        return
      }
      if (message.type !== 'command' || typeof message.id !== 'string') return
      const connection = socket
      try {
        const result = await control.handle(message.name, message.args)
        if (connection?.readyState === WebSocket.OPEN)
          connection.send(JSON.stringify({ type: 'result', id: message.id, result }))
      } catch (error: any) {
        if (connection?.readyState === WebSocket.OPEN)
          connection.send(
            JSON.stringify({
              type: 'result',
              id: message.id,
              error: {
                code: error.code ?? 'INVALID_ARGUMENT',
                message: error.message,
                details: error.details ?? null,
                retryable: false,
              },
            }),
          )
      }
    }
    socket.onclose = (event) => {
      badge.textContent = event.code === 1008 ? 'MCP 配对失败' : 'MCP 未连接'
      // 非“配对失败(1008)”的断线，2 秒后自动重连。
      if (!closed && event.code !== 1008) retry = setTimeout(connect, 2000)
    }
    socket.onerror = () => {
      badge.textContent = 'MCP 未连接'
    }
  }
  connect()
  addEventListener(
    'pagehide',
    () => {
      closed = true
      clearTimeout(retry)
      socket?.close()
    },
    { once: true },
  )
}
