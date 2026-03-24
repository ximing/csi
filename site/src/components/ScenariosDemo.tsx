import { useEffect, useState } from 'react'
import { useLang } from '../i18n/LangContext'
import './ScenariosDemo.css'

const STEPS = 7
const DURATIONS = [1400, 1200, 1400, 1200, 1400, 1800, 1400]

export default function ScenariosDemo() {
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
  const cur = step === 0 ? t.scenarios.cmd1 : step === 2 ? t.scenarios.cmd2 : step === 4 ? t.scenarios.cmd3 : ''

  useEffect(() => {
    if (!cur) { setTyped(0); return }
    setTyped(0)
    const id = setInterval(() => setTyped(l => (l >= cur.length ? l : l + 1)), 45)
    return () => clearInterval(id)
  }, [step, cur])

  // text for a command line: typing if current, full if past, empty if future
  const line = (s: number, text: string) => (step === s ? text.slice(0, typed) : step > s ? text : '')

  const showPage = step >= 1 || reduce
  const highlight = step === 3
  const showAnswer = step >= 5 || reduce

  return (
    <div className="scenarios-demo">
      <div className="terminal">
        <div className="term-bar">
          <span className="dot red" /><span className="dot yellow" /><span className="dot green" />
          <span className="term-title">{t.scenarios.prompt}</span>
        </div>
        <div className="term-body">
          <div className={`term-line ${step === 0 ? 'typing' : ''}`}>
            <span className="prompt">&gt;</span> {line(0, t.scenarios.cmd1)}
          </div>
          {step >= 2 && (
            <div className={`term-line ${step === 2 ? 'typing' : ''}`}>
              <span className="prompt">&gt;</span> {line(2, t.scenarios.cmd2)}
            </div>
          )}
          {step >= 4 && (
            <div className={`term-line ${step === 4 ? 'typing' : ''}`}>
              <span className="prompt">&gt;</span> {line(4, t.scenarios.cmd3)}
            </div>
          )}
          {step >= 1 && step < 2 && <div className="term-info">{t.scenarios.reading}</div>}
          {step >= 3 && step < 4 && <div className="term-info">{t.scenarios.searching}</div>}
          {showAnswer && <div className="term-info accent">{t.scenarios.answer}</div>}
        </div>
      </div>
      {showPage && (
        <div className="browser">
          <div className="browser-bar">
            <span className="dot red" /><span className="dot yellow" /><span className="dot green" />
            <span className="url">{t.scenarios.pageUrl}</span>
          </div>
          <div className="browser-body">
            <div className="fake-page">
              <div className="fake-h1">
                <span className="eref">@e12</span> Pricing
              </div>
              <div className="plan-row">
                <span className="plan-name">Free</span>
                <span className="plan-price">$0</span>
              </div>
              <div className={`plan-row ${highlight ? 'highlight' : ''}`}>
                <span className="eref">@e17</span>
                <span className="plan-name">{t.scenarios.priceLabel}</span>
              </div>
              <div className="plan-row">
                <span className="plan-name">Team</span>
                <span className="plan-price">$99</span>
              </div>
            </div>
            {showAnswer && (
              <div className="answer-overlay">
                <span className="tape">{t.scenarios.answer}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
