import { useLang } from '../i18n/LangContext'
import './Security.css'

export default function Security() {
  const { t } = useLang()
  return (
    <section className="section" id="security">
      <div className="container">
        <h2 className="section-title">{t.security.title}</h2>
        <div className="security-grid">
          {t.security.items.map((item, i) => (
            <div className="security-card" key={i}>
              <span className="tape">{i === 0 ? t.security.tapeWarn : t.security.tapePower}</span>
              <h3>{item.title}</h3>
              <p>{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
