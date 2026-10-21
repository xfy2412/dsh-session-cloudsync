// M0 全链路实验（客户端半）：轮询宿主 /m0/state，发现 revision 变化就刷新会话列表。
//
// 预期：宿主 ingest 后，页面不刷新也会出现新工作区/会话；配合 warm=1 标题也正确。
window.__ModuleLoader__.load({
  id: 'dsh-session-cloudsync-m0-e2e',
  factory() {
    return {
      inject: ['sessions'],
      apply(ctx) {
        let lastRevision = 0
        const tick = async () => {
          try {
            const response = await fetch('/m0/state', { headers: { accept: 'application/json' } })
            if (!response.ok) return
            const state = await response.json()
            if (state.revision > lastRevision) {
              lastRevision = state.revision
              await ctx.get('sessions').refresh()
              console.log(`[m0-e2e] 已刷新列表（revision=${lastRevision}, session=${state.sessionId}）`)
            }
          } catch (error) {
            // 宿主未就绪或连接中断时静默重试。
          }
        }
        const timer = setInterval(tick, 1000)
        ctx.effect(() => () => clearInterval(timer))
        window.__m0e2e = { refresh: () => ctx.get('sessions').refresh(), tick, state: () => lastRevision }
        console.log('[m0-e2e] client hook ready')
      },
    }
  },
})
