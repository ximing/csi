import { useLang } from '../i18n/LangContext'
import ScenariosDemo from './ScenariosDemo'
import './Scenarios.css'

export default function Scenarios() {
  const { t } = useLang()
  return (
    <section className="section" id="scenarios">
      <div className="container">
        <h2 className="section-title">{t.scenarios.title}</h2>
        <p className="section-subtitle">{t.scenarios.subtitle}</p>
        <ScenariosDemo />
      </div>
    </section>
  )
}
