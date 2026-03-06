import { mount } from 'svelte'
import './theme.css'
import AppShell from './AppShell.svelte'

const app = mount(AppShell, {
  target: document.getElementById('app')!,
})

export default app
