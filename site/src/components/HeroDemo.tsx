import { useEffect, useState } from 'react'
import { useLang } from '../i18n/LangContext'
import './HeroDemo.css'

const STEPS = 7
const DURATIONS = [1300, 1100, 1300, 1100, 1300, 1600, 1300]

export default function HeroDemo() {
  const { t } = useLang()
  const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [step, setStep] = useState(() => (reduce ? 5 : 0))
  const [typed, setTyped] = useState(0)

  // advance the loop
  useEffect(() => {
    if (reduce) return
    const id = setTimeout(() => setStep(s => (s + 1) % STEPS), DURATIONS[step])
    return () => clearTimeout(id)
  }, [step, reduce])

  // current command being typed (steps 0, 2, 4)
  const cur = step === 0 ? t.heroDemo.cmd1 : step === 2 ? t.heroDemo.cmd2 : step === 4 ? t.heroDemo.cmd3 : ''

  useEffect(() => {
    if (!cur) { setTyped(0); return }
    setTyped(0)
    const id = setInterval(() => setTyped(l => (l >= cur.length ? l : l + 1)), 45)
    return () => clearInterval(id)
  }, [step, cur])

  // text for a command line: typing if current, full if past, empty if future
  const line = (s: number, text: string) => (step === s ? text.slice(0, typed) : step > s ? text : '')

  const showBrowser = step >= 1 || reduce
  const highlight = step === 3
  const showShot = step >= 5 || reduce

  return (
    <div className="hero-demo">
      <div className="terminal">
        <div className="term-bar">
          <span className="dot red" /><span className="dot yellow" /><span className="dot green" />
          <span className="term-title">{t.heroDemo.prompt}</span>
        </div>
        <div className="term-body">
          <div className={`term-line ${step === 0 ? 'typing' : ''}`}>
            <span className="prompt">&gt;</span> {line(0, t.heroDemo.cmd1)}
          </div>
          {step >= 2 && (
            <div className={`term-line ${step === 2 ? 'typing' : ''}`}>
              <span className="prompt">&gt;</span> {line(2, t.heroDemo.cmd2)}
            </div>
          )}
          {step >= 4 && (
            <div className={`term-line ${step === 4 ? 'typing' : ''}`}>
              <span className="prompt">&gt;</span> {line(4, t.heroDemo.cmd3)}
            </div>
          )}
          {step >= 1 && step < 2 && <div className="term-info">{t.heroDemo.opening}</div>}
          {step >= 3 && step < 4 && <div className="term-info">{t.heroDemo.clicking}</div>}
          {showShot && <div className="term-info accent">{t.heroDemo.captured}</div>}
        </div>
      </div>
      {showBrowser && (
        <div className="browser">
          <div className="browser-bar">
            <span className="dot red" /><span className="dot yellow" /><span className="dot green" />
            <span className="url">example.com</span>
          </div>
          <div className="browser-body">
            <div className="fake-page">
              <div className="fake-logo" />
              <div className="fake-line" />
              <div className="fake-line short" />
              <div className={`fake-btn ${highlight ? 'highlight' : ''}`}>Login</div>
            </div>
            {showShot && (
              <div className="screenshot">
                <span className="tape">{t.heroDemo.evidence}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
