import { useLang } from '../i18n/LangContext'
import ScenariosDemo from './ScenariosDemo'
import DebugDemo from './DebugDemo'
import E2EFlow from './E2E'
import './Scenarios.css'

export default function Scenarios() {
  const { t } = useLang()
  const s = t.scenarios
  return (
    <section className="section" id="scenarios">
      <div className="container">
        <h2 className="section-title">{s.title}</h2>
        <p className="section-subtitle">{s.subtitle}</p>

        <div className="scenario">
          <div className="scenario-head">
            <span className="scenario-num">#1</span>
            <div>
              <h3>{s.s1Title}</h3>
              <p className="scenario-desc">{s.s1Desc}</p>
            </div>
          </div>
          <ScenariosDemo />
        </div>

        <div className="scenario">
          <div className="scenario-head">
            <span className="scenario-num">#2</span>
            <div>
              <h3>{s.s2Title}</h3>
              <p className="scenario-desc">{s.s2Desc}</p>
            </div>
          </div>
          <DebugDemo />
        </div>

        <div className="scenario">
          <div className="scenario-head">
            <span className="scenario-num">#3</span>
            <div>
              <h3>{s.s3Title}</h3>
              <p className="scenario-desc">{s.s3Desc}</p>
            </div>
          </div>
          <E2EFlow />
        </div>
      </div>
    </section>
  )
}
