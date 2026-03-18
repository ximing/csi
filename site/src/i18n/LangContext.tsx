import { createContext, useContext, useState, ReactNode } from 'react'
import { zh } from './zh'
import { en } from './en'

export type Lang = 'zh' | 'en'
type Dict = typeof zh

const dicts: Record<Lang, Dict> = { zh, en }

interface LangCtx {
  lang: Lang
  t: Dict
  setLang: (l: Lang) => void
}

const Ctx = createContext<LangCtx>(null!)

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>('zh')
  return <Ctx.Provider value={{ lang, t: dicts[lang], setLang }}>{children}</Ctx.Provider>
}

export function useLang() {
  return useContext(Ctx)
}
