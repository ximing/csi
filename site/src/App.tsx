import Nav from './components/Nav'
import Hero from './components/Hero'
import Features from './components/Features'
import Architecture from './components/Architecture'
import Scenarios from './components/Scenarios'
import Tools from './components/Tools'
import QuickStart from './components/QuickStart'
import E2E from './components/E2E'
import Security from './components/Security'
import Footer from './components/Footer'

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Features />
        <Architecture />
        <Scenarios />
        <Tools />
        <QuickStart />
        <E2E />
        <Security />
      </main>
      <Footer />
    </>
  )
}
