import { useLang } from '../i18n/LangContext'
import './Footer.css'

export default function Footer() {
  const { t, lang } = useLang()
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-left">
          <span className="footer-tag">{t.footer.tagline}</span>
          <span className="footer-version">{t.footer.version}</span>
        </div>
        <div className="footer-links">
          <a href="https://github.com/ximing/csi" target="_blank" rel="noreferrer">{t.footer.github}</a>
          <a href={lang === 'zh' ? 'https://github.com/ximing/csi/blob/master/README.zh-CN.md' : 'https://github.com/ximing/csi/blob/master/README.md'} target="_blank" rel="noreferrer">{t.footer.readme}</a>
          <a href="https://github.com/ximing/csi/blob/master/docs/protocol.md" target="_blank" rel="noreferrer">{t.footer.protocol}</a>
        </div>
      </div>
    </footer>
  )
}
