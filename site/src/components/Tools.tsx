import { useLang } from '../i18n/LangContext'
import { tools } from '../data/tools'
import './Tools.css'

export default function Tools() {
  const { lang, t } = useLang()
  return (
    <section className="section" id="tools">
      <div className="container">
        <h2 className="section-title">{t.tools.title}</h2>
        <p className="section-subtitle">{t.tools.subtitle}</p>
        <div className="tools-grid">
          {tools.map(tool => (
            <div className="tool-card" key={tool.name}>
              <code className="tool-name">{tool.name}</code>
              <span className="tool-desc">{tool[lang]}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
