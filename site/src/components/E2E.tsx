import { useLang } from '../i18n/LangContext'
import './E2E.css'

export default function E2E() {
  const { t } = useLang()
  return (
    <section className="section" id="e2e">
      <div className="container">
        <h2 className="section-title">{t.e2e.title}</h2>
        <p className="section-subtitle">{t.e2e.subtitle}</p>
        <div className="e2e-flow">
          {t.e2e.steps.map((step, i) => (
            <div className="e2e-step" key={i}>
              <div className="e2e-index">{i + 1}</div>
              <h3>{step.title}</h3>
              <p>{step.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
