import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = () => {}

// jsdom doesn't implement IntersectionObserver — DiffPanel uses it for
// file-tab active-state tracking. No-op stub: observer never fires, which
// is fine for tests (activeFilePath stays null).
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
} as unknown as typeof IntersectionObserver
