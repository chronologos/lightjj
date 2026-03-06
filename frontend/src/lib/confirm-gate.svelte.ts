/**
 * Double-press confirmation for destructive keyboard actions.
 *
 * First press arms the key (UI shows "press again to confirm"); second press
 * of the SAME key fires. Any other key/action disarms. No timeout — changing
 * selection or navigating away disarms naturally.
 *
 * Usage:
 *   const confirm = createConfirmGate<'d' | 'f'>()
 *   case 'd':
 *     if (confirm.gate('d', true)) return  // armed, don't fire
 *     fire()                               // second press
 */
export function createConfirmGate<K extends string>() {
  let armed = $state<K | null>(null)
  return {
    get armed() { return armed },
    /**
     * @returns true = just armed, caller should NOT fire.
     *          false = already armed (second press) or non-destructive; caller fires.
     */
    gate(key: K, destructive: boolean): boolean {
      if (!destructive) { armed = null; return false }
      if (armed === key) { armed = null; return false }
      armed = key
      return true
    },
    disarm() { armed = null },
  }
}
