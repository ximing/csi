import { useLang } from '../i18n/LangContext'
import './LangToggle.css'

export default function LangToggle() {
  const { lang, setLang } = useLang()
  return (
    <div className="lang-toggle">
      <button className={lang === 'zh' ? 'active' : ''} onClick={() => setLang('zh')}>中</button>
      <span className="sep">/</span>
      <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
    </div>
  )
}
