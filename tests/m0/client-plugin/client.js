// M0 客户端实验模块：把客户端 Cordis 上下文里的刷新入口暴露到 window，供浏览器里验证。
//
// 关键结论候选：ctx.get('sessions').refresh() 会重拉会话列表基线（不是整页刷新）。
window.__ModuleLoader__.load({
  id: 'dsh-session-sync-m0-client',
  factory() {
    return {
      inject: ['sessions'],
      apply(ctx) {
        window.__m0 = {
          ctx,
          sessions: ctx.get('sessions'),
          workspaces: ctx.get('workspaces'),
          uiWorkspace: ctx.get('uiWorkspace'),
          refreshSessions: () => ctx.get('sessions').refresh(),
          /** 列出某个服务原型上的方法名，便于找"刷新工作区"的入口。 */
          methods(name) {
            const service = ctx.get(name)
            if (service === undefined) return null
            const names = new Set()
            let proto = Object.getPrototypeOf(service)
            while (proto !== null && proto !== Object.prototype) {
              for (const key of Object.getOwnPropertyNames(proto)) if (typeof service[key] === 'function') names.add(key)
              proto = Object.getPrototypeOf(proto)
            }
            return [...names].sort()
          },
        }
        console.log('[m0-client] refresh hook ready')
      },
    }
  },
})
