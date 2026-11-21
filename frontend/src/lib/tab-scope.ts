// Which tab's backend a request goes to. Each tab is a full Server mounted at
// /tab/{id}/; `activeBase` follows the tab the user is looking at.
//
// A flow with more than one request must NOT follow it: the {#key} remount
// destroys a tab's components but not its suspended async functions, so a save
// that awaits between two requests would send the second to whichever tab is
// active by then — writing one repo's file into another. bindTab() pins a client
// to the tab that was active when the flow's owner was created.

let activeBase = '/tab/0'
let pinned: string | null = null

export const getActiveBase = () => activeBase
export const setActiveBase = (base: string) => { activeBase = base }

/** Base for a request being issued right now. Must be read synchronously. */
export const requestBase = () => pinned ?? activeBase

/** Wrap an api client so every call goes to `base`, whatever tab is active by
 *  then. Works because api methods resolve their URL synchronously, before the
 *  first await. Nested namespaces (api.annotations.*) are wrapped too. */
export function bindTab<T extends object>(client: T, base: string = activeBase): T {
  return new Proxy(client, {
    get(target, prop) {
      const v = Reflect.get(target, prop)
      if (typeof v === 'function') {
        return (...args: unknown[]) => {
          const prev = pinned
          pinned = base
          try { return v.apply(target, args) } finally { pinned = prev }
        }
      }
      return v !== null && typeof v === 'object' ? bindTab(v as object, base) : v
    },
  })
}
