import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import { AppProvider } from './context/AppContext'
import App from './App'
import { initTheme } from './utils/theme'
import './styles/index.css'
import './styles/theme-light.css'

initTheme()

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <HashRouter>
            <AppProvider>
                <App />
            </AppProvider>
        </HashRouter>
    </StrictMode>
)
