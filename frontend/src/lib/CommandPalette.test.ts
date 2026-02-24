import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import CommandPalette from './CommandPalette.svelte'
import type { PaletteCommand } from './CommandPalette.svelte'

function makeCommands(): PaletteCommand[] {
  return [
    { label: 'New revision', action: vi.fn() },
    { label: 'Abandon revision', action: vi.fn() },
    { label: 'Edit revision', action: vi.fn() },
    { label: 'Rebase', shortcut: 'R', category: 'Navigation', action: vi.fn() },
    { label: 'Squash', shortcut: 'S', category: 'Navigation', action: vi.fn() },
  ]
}

describe('CommandPalette', () => {
  describe('rendering', () => {
    it('not visible when open=false', () => {
      const { container } = render(CommandPalette, { props: { commands: makeCommands(), open: false } })
      expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument()
    })

    it('renders as dialog when open=true', () => {
      render(CommandPalette, { props: { commands: makeCommands(), open: true } })
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('shows all commands when no query (filtered list mode)', async () => {
      // Commands without shortcuts → filtered list mode (not cheatsheet)
      const cmds: PaletteCommand[] = [
        { label: 'Alpha', action: vi.fn() },
        { label: 'Beta', action: vi.fn() },
      ]
      render(CommandPalette, { props: { commands: cmds, open: true } })
      expect(screen.getByText('Alpha')).toBeInTheDocument()
      expect(screen.getByText('Beta')).toBeInTheDocument()
    })

    it('cheatsheet mode groups commands by category with shortcuts', () => {
      const cmds: PaletteCommand[] = [
        { label: 'Rebase', shortcut: 'R', category: 'Actions', action: vi.fn() },
        { label: 'Squash', shortcut: 'S', category: 'Actions', action: vi.fn() },
        { label: 'Search', shortcut: '/', category: 'Navigation', action: vi.fn() },
      ]
      render(CommandPalette, { props: { commands: cmds, open: true } })
      expect(screen.getByText('Actions')).toBeInTheDocument()
      expect(screen.getByText('Navigation')).toBeInTheDocument()
    })
  })

  describe('filtering', () => {
    it('typing query filters commands via fuzzyMatch', async () => {
      const cmds: PaletteCommand[] = [
        { label: 'New revision', action: vi.fn() },
        { label: 'Abandon', action: vi.fn() },
      ]
      render(CommandPalette, { props: { commands: cmds, open: true } })
      const input = screen.getByPlaceholderText('Type a command...')
      await fireEvent.input(input, { target: { value: 'abn' } })
      // 'abn' fuzzy-matches 'Abandon' but not 'New revision'
      expect(screen.getByText('Abandon')).toBeInTheDocument()
      expect(screen.queryByText('New revision')).not.toBeInTheDocument()
    })

    it('commands with when() returning false are excluded', () => {
      const cmds: PaletteCommand[] = [
        { label: 'Visible', action: vi.fn() },
        { label: 'Hidden', action: vi.fn(), when: () => false },
      ]
      render(CommandPalette, { props: { commands: cmds, open: true } })
      expect(screen.getByText('Visible')).toBeInTheDocument()
      expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
    })
  })

  describe('keyboard', () => {
    it('ArrowDown moves selection down', async () => {
      const cmds: PaletteCommand[] = [
        { label: 'First', action: vi.fn() },
        { label: 'Second', action: vi.fn() },
      ]
      render(CommandPalette, { props: { commands: cmds, open: true } })
      const input = screen.getByPlaceholderText('Type a command...')
      await fireEvent.keyDown(input, { key: 'ArrowDown' })
      // Second item should now be active
      const items = document.querySelectorAll('.palette-item')
      expect(items[1]).toHaveClass('palette-item-active')
    })

    it('ArrowUp moves selection up', async () => {
      const cmds: PaletteCommand[] = [
        { label: 'First', action: vi.fn() },
        { label: 'Second', action: vi.fn() },
      ]
      render(CommandPalette, { props: { commands: cmds, open: true } })
      const input = screen.getByPlaceholderText('Type a command...')
      // Move down first, then up
      await fireEvent.keyDown(input, { key: 'ArrowDown' })
      await fireEvent.keyDown(input, { key: 'ArrowUp' })
      const items = document.querySelectorAll('.palette-item')
      expect(items[0]).toHaveClass('palette-item-active')
    })

    it('Enter executes selected command', async () => {
      const action = vi.fn()
      const cmds: PaletteCommand[] = [
        { label: 'First', action },
      ]
      render(CommandPalette, { props: { commands: cmds, open: true } })
      const input = screen.getByPlaceholderText('Type a command...')
      await fireEvent.keyDown(input, { key: 'Enter' })
      expect(action).toHaveBeenCalledTimes(1)
    })

    it('Escape closes palette', async () => {
      const cmds: PaletteCommand[] = [
        { label: 'First', action: vi.fn() },
      ]
      const { container } = render(CommandPalette, { props: { commands: cmds, open: true } })
      const input = screen.getByPlaceholderText('Type a command...')
      await fireEvent.keyDown(input, { key: 'Escape' })
      expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument()
    })

    it('index resets to 0 on input change', async () => {
      const cmds: PaletteCommand[] = [
        { label: 'Alpha', action: vi.fn() },
        { label: 'Beta', action: vi.fn() },
      ]
      render(CommandPalette, { props: { commands: cmds, open: true } })
      const input = screen.getByPlaceholderText('Type a command...')
      await fireEvent.keyDown(input, { key: 'ArrowDown' })
      // index is now 1
      await fireEvent.input(input, { target: { value: 'a' } })
      // index should reset to 0
      const items = document.querySelectorAll('.palette-item')
      if (items.length > 0) {
        expect(items[0]).toHaveClass('palette-item-active')
      }
    })
  })

  describe('execution', () => {
    it('clicking a command calls its action', async () => {
      const action = vi.fn()
      const cmds: PaletteCommand[] = [
        { label: 'Click me', action },
      ]
      render(CommandPalette, { props: { commands: cmds, open: true } })
      await fireEvent.click(screen.getByText('Click me'))
      expect(action).toHaveBeenCalledTimes(1)
    })

    it('palette closes after execution', async () => {
      const cmds: PaletteCommand[] = [
        { label: 'Do it', action: vi.fn() },
      ]
      const { container } = render(CommandPalette, { props: { commands: cmds, open: true } })
      await fireEvent.click(screen.getByText('Do it'))
      expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument()
    })
  })
})
