import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { LangProvider, type Lang } from './i18n/LangContext'
import './styles/theme.css'

const initialLang: Lang =
  (window as unknown as { __INITIAL_LANG__?: string }).__INITIAL_LANG__ === 'en' ? 'en' : 'zh'

const rootEl = document.getElementById('root')!
const app = (
  <React.StrictMode>
    <LangProvider initialLang={initialLang}>
      <App />
    </LangProvider>
  </React.StrictMode>
)

if (rootEl.hasChildNodes()) {
  ReactDOM.hydrateRoot(rootEl, app)
} else {
  ReactDOM.createRoot(rootEl).render(app)
}
