import { useState } from 'react'
import { useLang } from '../i18n/LangContext'
import './QuickStart.css'

const STORE_URL = 'https://chromewebstore.google.com/detail/csi/mlnlngdpkodcnblmdgdnlaidijaffeol'

const CMDS = {
  store: {
    mac: 'curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash -s -- --no-extension',
    win: "$env:CSI_NO_EXTENSION='1'; irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex",
  },
  github: {
    mac: 'curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash',
    win: 'irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex',
  },
} as const

const STATUS_CMD = 'curl -s http://127.0.0.1:10088/status'

const AGENT_INSTALLS: Array<{ tool: string; cmd: string; hint?: string }> = [
  { tool: 'Claude Code', cmd: '/plugin marketplace add ximing/csi\n/plugin install csi@csi' },
  { tool: 'Codex App / CLI', cmd: 'codex plugin marketplace add ximing/csi\ncodex plugin add csi@csi' },
  { tool: 'Cursor', cmd: '/add-plugin csi' },
  { tool: 'Grok Build CLI', cmd: 'grok plugin install csi@xai-official --trust', hint: 'xAI 官方市场收录 PR 审核中 / xAI official marketplace listing in review' },
  { tool: 'Kimi Code', cmd: '/plugins install https://github.com/ximing/csi' },
  { tool: 'OpenCode', cmd: '"plugin": ["csi@git+https://github.com/ximing/csi.git"]  // opencode.json' },
  { tool: 'Pi', cmd: 'pi install git:github.com/ximing/csi' },
]

type Mode = 'store' | 'github'
type OsTab = 'mac' | 'win'

export default function QuickStart() {
  const { t } = useLang()
  const [mode, setMode] = useState<Mode>('store')
  const [tab, setTab] = useState<OsTab>('mac')
  const [copied, setCopied] = useState(false)
  const cmd = CMDS[mode][tab]

  const copy = async () => {
    await navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="section" id="quickstart">
      <div className="container">
        <h2 className="section-title">{t.quickstart.title}</h2>
        <p className="qs-intro">{t.quickstart.intro}</p>

        <div className="qs-mode-tabs" role="tablist" aria-label={t.quickstart.title}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'store'}
            className={mode === 'store' ? 'active' : ''}
            onClick={() => setMode('store')}
          >
            {t.quickstart.modeStore}
            <span className="qs-badge">{t.quickstart.modeStoreBadge}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'github'}
            className={mode === 'github' ? 'active' : ''}
            onClick={() => setMode('github')}
          >
            {t.quickstart.modeGithub}
          </button>
        </div>

        {mode === 'store' ? (
          <>
            <p className="step-text">{t.quickstart.storeStep1}</p>
            <a className="btn btn-primary qs-store-cta" href={STORE_URL} target="_blank" rel="noreferrer">
              {t.quickstart.storeCta}
            </a>
            <p className="step-text">{t.quickstart.storeStep2}</p>
          </>
        ) : (
          <p className="step-text">{t.quickstart.githubStep1}</p>
        )}

        <div className="cmd-block">
          <div className="cmd-tabs">
            <button type="button" className={tab === 'mac' ? 'active' : ''} onClick={() => setTab('mac')}>{t.quickstart.mac}</button>
            <button type="button" className={tab === 'win' ? 'active' : ''} onClick={() => setTab('win')}>{t.quickstart.windows}</button>
            <button type="button" className="copy-btn" onClick={copy}>{copied ? t.quickstart.copied : t.quickstart.copy}</button>
          </div>
          <pre className="cmd-code"><code>{cmd}</code></pre>
        </div>

        <p className="step-text">{mode === 'store' ? t.quickstart.storeStep3 : t.quickstart.githubStep2}</p>
        {mode === 'github' && <p className="step-text">{t.quickstart.githubStep3}</p>}
        <p className="step-text">{t.quickstart.stepStatus}</p>
        <pre className="cmd-code"><code>{STATUS_CMD}</code></pre>
        <p className="qs-note">{t.quickstart.note}</p>
        <h3 className="qs-skills-title">{t.quickstart.skillsTitle}</h3>
        <p className="step-text">{t.quickstart.skillsIntro}</p>
        <div className="qs-skills">
          {AGENT_INSTALLS.map(({ tool, cmd: agentCmd, hint }) => (
            <div className="qs-skill-row" key={tool}>
              <span className="qs-skill-tool">{tool}</span>
              <code className="qs-skill-cmd">{agentCmd}</code>
              {hint && <span className="qs-skill-hint">{hint}</span>}
            </div>
          ))}
        </div>
        <p className="qs-note">{t.quickstart.skillsMore}</p>
      </div>
    </section>
  )
}
