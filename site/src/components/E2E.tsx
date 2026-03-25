import { useLang } from '../i18n/LangContext'
import './E2E.css'

export default function E2EFlow() {
  const { t } = useLang()
  return (
    <div className="e2e-flow">
      {t.scenarios.e2e.steps.map((step, i) => (
        <div className="e2e-step" key={i}>
          <div className="e2e-index">{i + 1}</div>
          <h3>{step.title}</h3>
          <p>{step.desc}</p>
        </div>
      ))}
    </div>
  )
}
