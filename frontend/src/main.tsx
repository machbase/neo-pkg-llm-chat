import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider } from './context/AppContext'
import App from './App'
import { initTheme } from './utils/theme'
import { reloadIfStale } from './utils/staleReload'
import './styles/index.css'
import './styles/theme-light.css'

reloadIfStale()
initTheme()

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <AppProvider>
            <App />
        </AppProvider>
    </StrictMode>
)
