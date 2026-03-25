import Nav from './components/Nav'
import Hero from './components/Hero'
import QuickStart from './components/QuickStart'
import Scenarios from './components/Scenarios'
import Architecture from './components/Architecture'
import Tools from './components/Tools'
import Security from './components/Security'
import Footer from './components/Footer'

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <QuickStart />
        <Scenarios />
        <Architecture />
        <Tools />
        <Security />
      </main>
      <Footer />
    </>
  )
}
