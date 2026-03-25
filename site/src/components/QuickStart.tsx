import { useState } from 'react'
import { useLang } from '../i18n/LangContext'
import './QuickStart.css'

const MAC_CMD = 'curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash'
const WIN_CMD = 'irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex'
const STATUS_CMD = 'curl -s http://127.0.0.1:10088/status'

export default function QuickStart() {
  const { t } = useLang()
  const [tab, setTab] = useState<'mac' | 'win'>('mac')
  const [copied, setCopied] = useState(false)
  const cmd = tab === 'mac' ? MAC_CMD : WIN_CMD

  const copy = async () => {
    await navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="section" id="quickstart">
      <div className="container">
        <h2 className="section-title">{t.quickstart.title}</h2>
        <p className="step-text">{t.quickstart.step1}</p>
        <div className="cmd-block">
          <div className="cmd-tabs">
            <button className={tab === 'mac' ? 'active' : ''} onClick={() => setTab('mac')}>{t.quickstart.mac}</button>
            <button className={tab === 'win' ? 'active' : ''} onClick={() => setTab('win')}>{t.quickstart.windows}</button>
            <button className="copy-btn" onClick={copy}>{copied ? t.quickstart.copied : t.quickstart.copy}</button>
          </div>
          <pre className="cmd-code"><code>{cmd}</code></pre>
        </div>
        <p className="step-text">{t.quickstart.step2}</p>
        <p className="step-text">{t.quickstart.step3}</p>
        <pre className="cmd-code"><code>{STATUS_CMD}</code></pre>
        <p className="qs-note">{t.quickstart.note}</p>
      </div>
    </section>
  )
}
