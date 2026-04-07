export interface Tool {
  name: string
  zh: string
  en: string
}

export const tools: Tool[] = [
  { name: 'navigate', zh: '打开/切换标签页，导航到 URL', en: 'Open/switch tab, navigate to a URL' },
  { name: 'find_tab', zh: '按标题或 URL 查找已打开的标签页', en: 'Find an open tab by title or URL' },
  { name: 'snapshot', zh: '取无障碍树，返回带 @e 引用的元素', en: 'Accessibility tree with @e element refs' },
  { name: 'click', zh: '按 @e 引用点击元素', en: 'Click an element by @e ref' },
  { name: 'fill', zh: '填充输入框或 contenteditable', en: 'Fill inputs or contenteditable' },
  { name: 'evaluate', zh: '在页面内执行任意 JS', en: 'Run arbitrary JS in the page' },
  { name: 'network', zh: '监听/捕获网络请求', en: 'Monitor/capture network requests' },
  { name: 'mouse_click', zh: '坐标级可信点击', en: 'Trusted coordinate-level clicks' },
  { name: 'wait', zh: '等到文字、元素或 URL', en: 'Wait for text, an element, or a URL' },
  { name: 'scroll', zh: '滚动页面或滚到元素', en: 'Scroll the page or an element into view' },
  { name: 'hover', zh: '悬停展开 :hover 菜单', en: 'Hover to open CSS :hover menus' },
  { name: 'key_type', zh: '按键逐字输入', en: 'Type keys character by character' },
  { name: 'send_keys', zh: '发送按键事件（含修饰键）', en: 'Send key events (with modifiers)' },
  { name: 'cdp', zh: '原始 CDP 透传', en: 'Raw CDP passthrough' },
  { name: 'screenshot', zh: '截图，返回文件路径', en: 'Screenshot, returns a file path' },
  { name: 'save_as_pdf', zh: '保存为 PDF', en: 'Save page as PDF' },
  { name: 'upload', zh: '上传文件', en: 'Upload a file' },
  { name: 'list_tabs', zh: '列出当前所有标签页', en: 'List all open tabs' },
  { name: 'close_tab', zh: '关闭指定标签页', en: 'Close a specific tab' },
  { name: 'close_session', zh: '关闭整个 session 的标签页', en: 'Close all tabs in a session' },
  { name: 'list_frames', zh: '列出全部帧，跨域标 isolated', en: 'List all frames; cross-origin marked isolated' },
]
