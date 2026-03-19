import { useLang } from '../i18n/LangContext'
import HeroDemo from './HeroDemo'
import './Hero.css'

export default function Hero() {
  const { t } = useLang()
  return (
    <section className="hero">
      <div className="container hero-grid">
        <div className="hero-text">
          <span className="tape hero-tape">案发现场 / Crime Scene</span>
          <h1 className="hero-title">{t.hero.title}</h1>
          <p className="hero-subtitle">{t.hero.subtitle}</p>
          <div className="hero-cta">
            <a className="btn btn-primary" href="#quickstart">{t.hero.ctaStart}</a>
            <a className="btn btn-ghost" href="#tools">{t.hero.ctaTools}</a>
          </div>
        </div>
        <HeroDemo />
      </div>
    </section>
  )
}
