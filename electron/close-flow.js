/**
 * Decides whether a window close or app quit may proceed once the renderer has
 * been asked to flush its unsaved edits. Dependencies are injected so the
 * decision logic can be tested without Electron.
 *
 * Resolves to `'approved'` (safe to close for real) or `'cancelled'` (the user
 * chose to keep the window open). Concurrent requests share one result so a
 * quit and a window close never prompt twice.
 */
export function createCloseFlow({ requestFlush, confirmCloseAnyway, isRendererAvailable }) {
  let inFlight = null

  async function decide() {
    // A crashed or destroyed renderer has nothing left to flush and must never
    // make the window unclosable.
    if (!isRendererAvailable()) return 'approved'
    let flushed = false
    try {
      flushed = (await requestFlush()) === true
    } catch {
      flushed = false
    }
    if (flushed) return 'approved'
    if (!isRendererAvailable()) return 'approved'
    return (await confirmCloseAnyway()) ? 'approved' : 'cancelled'
  }

  return {
    requestClose() {
      if (!inFlight) {
        inFlight = decide().finally(() => {
          inFlight = null
        })
      }
      return inFlight
    },
    isPending: () => inFlight !== null,
  }
}
