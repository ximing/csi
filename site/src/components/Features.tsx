import { useLang } from '../i18n/LangContext'
import './Features.css'

export default function Features() {
  const { t } = useLang()
  return (
    <section className="section" id="features">
      <div className="container">
        <h2 className="section-title">{t.features.title}</h2>
        <div className="features-grid">
          {t.features.items.map((item, i) => (
            <div className="feature-card" key={i}>
              <h3>{item.title}</h3>
              <p>{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
