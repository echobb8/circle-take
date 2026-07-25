import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installMockIfNeeded } from './mock'

// Must run before the store touches window.circletake.
installMockIfNeeded()

const host = document.getElementById('root')
if (!host) throw new Error('#root missing')

createRoot(host).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
