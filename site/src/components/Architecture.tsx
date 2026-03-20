import { useLang } from '../i18n/LangContext'
import './Architecture.css'

export default function Architecture() {
  const { t } = useLang()
  return (
    <section className="section" id="architecture">
      <div className="container">
        <h2 className="section-title">{t.arch.title}</h2>
        <p className="section-subtitle">{t.arch.desc}</p>
        <svg className="arch-svg" viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={t.arch.title}>
          {/* AI client box */}
          <rect x="20" y="120" width="180" height="60" rx="8" className="arch-box" />
          <text x="110" y="155" textAnchor="middle" className="arch-label">{t.arch.aiClient}</text>

          {/* daemon box */}
          <rect x="280" y="60" width="200" height="180" rx="8" className="arch-box arch-daemon" />
          <text x="380" y="95" textAnchor="middle" className="arch-label">{t.arch.daemon}</text>
          <text x="380" y="120" textAnchor="middle" className="arch-mono">127.0.0.1:10088</text>
          <text x="380" y="210" textAnchor="middle" className="arch-note">{t.arch.note}</text>

          {/* extension box */}
          <rect x="560" y="120" width="180" height="60" rx="8" className="arch-box" />
          <text x="650" y="155" textAnchor="middle" className="arch-label">{t.arch.extension}</text>

          {/* arrows */}
          <line x1="200" y1="150" x2="280" y2="150" className="arch-arrow" markerEnd="url(#ah)" />
          <text x="240" y="140" textAnchor="middle" className="arch-edge">{t.arch.httpLabel}</text>

          <line x1="480" y1="150" x2="560" y2="150" className="arch-arrow" markerEnd="url(#ah)" />
          <text x="520" y="140" textAnchor="middle" className="arch-edge">{t.arch.wsLabel}</text>

          <defs>
            <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6 Z" className="arch-arrowhead" />
            </marker>
          </defs>
        </svg>
      </div>
    </section>
  )
}
