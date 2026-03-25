import { useLang } from '../i18n/LangContext'
import LangToggle from './LangToggle'
import './Nav.css'

export default function Nav() {
  const { t } = useLang()
  return (
    <nav className="nav">
      <div className="container nav-inner">
        <span className="case-id">{t.nav.caseId}</span>
        <div className="nav-anchors">
          <a href="#quickstart">{t.nav.anchors.start}</a>
          <a href="#scenarios">{t.nav.anchors.scenarios}</a>
          <a href="#architecture">{t.nav.anchors.internals}</a>
        </div>
        <div className="nav-right">
          <LangToggle />
          <a className="nav-link" href="https://github.com/ximing/csi" target="_blank" rel="noreferrer">{t.nav.github}</a>
        </div>
      </div>
    </nav>
  )
}
