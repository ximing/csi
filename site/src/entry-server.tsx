import { renderToString } from 'react-dom/server'
import App from './App'
import { LangProvider, type Lang } from './i18n/LangContext'

export function render(lang: Lang) {
  return renderToString(
    <LangProvider initialLang={lang}>
      <App />
    </LangProvider>,
  )
}
