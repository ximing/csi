package mcp

// 工具定义：名称、描述、inputSchema（协议 §4）。
// 每个工具额外带可选顶层参数 session（string，默认 "default"），
// 映射到 /command 请求体的 session 字段（协议 §2.1）。

type toolDef struct {
	name        string
	description string
	props       map[string]any // 工具自身参数（不含 session）
	required    []string
}

func strProp(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func boolProp(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}

func intProp(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}

func numProp(desc string) map[string]any {
	return map[string]any{"type": "number", "description": desc}
}

func strEnumProp(desc string, values ...string) map[string]any {
	enum := make([]any, len(values))
	for i, v := range values {
		enum[i] = v
	}
	return map[string]any{"type": "string", "description": desc, "enum": enum}
}

func strSliceProp(desc string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": desc}
}

var sessionProp = map[string]any{
	"type":        "string",
	"description": "Session name. Tabs opened by a tool call are grouped per session (tab group agent:<session>); reuse the same session within one task.",
	"default":     "default",
}

// inputSchema 生成 MCP inputSchema：object，properties = 工具参数 + session。
func (t toolDef) inputSchema() map[string]any {
	props := make(map[string]any, len(t.props)+1)
	for k, v := range t.props {
		props[k] = v
	}
	props["session"] = sessionProp
	required := make([]any, len(t.required))
	for i, r := range t.required {
		required[i] = r
	}
	return map[string]any{
		"type":       "object",
		"properties": props,
		"required":   required,
	}
}

var toolDefs = []toolDef{
	{
		name:        "navigate",
		description: "Navigate the browser to a URL and wait for page load (reuses the session's current tab unless newTab is true).",
		props: map[string]any{
			"url":         strProp("URL to navigate to."),
			"newTab":      boolProp("Open in a new background tab instead of reusing the current tab."),
			"group_title": strProp("Custom title for the session's Chrome tab group."),
		},
		required: []string{"url"},
	},
	{
		name:        "find_tab",
		description: "Find an open tab by URL domain within the session's tabs and make it the session's current tab.",
		props: map[string]any{
			"url":    strProp("URL or domain to match against the session's tabs."),
			"active": boolProp("Borrow the tab the user is currently viewing (not added to the session group)."),
		},
		required: []string{"url"},
	},
	{
		name:        "snapshot",
		description: "Capture the accessibility tree of the current page; interactive elements are tagged with @eN refs usable as selectors.",
		props: map[string]any{
			"mode":      strEnumProp("Snapshot verbosity. compact=YAML with structure+refs (default); interactive=refs only; full=JSON tree.", "compact", "interactive", "full"),
			"selector":  strProp("Limit the snapshot to this element (@e ref or CSS)."),
			"max_chars": intProp("Max YAML characters for compact/interactive (default 24000, range 1000-80000)."),
			"frame":     strProp("Enter a same-origin iframe and snapshot only it: CDP frameId or an untruncated substring of the frame URL. Alternative to passing a selector that points at an iframe @e ref."),
		},
	},
	{
		name:        "click",
		description: "Click an element via a DOM-level el.click().",
		props: map[string]any{
			"selector": strProp("@eN ref (from snapshot) or CSS selector of the element to click."),
			"frame":    strProp("Frame to resolve CSS selectors in (frameId or URL substring). Ignored for @e refs — they carry their own frame."),
		},
		required: []string{"selector"},
	},
	{
		name:        "fill",
		description: "Fill an input, textarea, or contenteditable element with a value.",
		props: map[string]any{
			"selector": strProp("@eN ref (from snapshot) or CSS selector of the element to fill."),
			"value":    strProp("Value to set."),
			"frame":    strProp("Frame to resolve CSS selectors in (frameId or URL substring). Ignored for @e refs — they carry their own frame."),
		},
		required: []string{"selector", "value"},
	},
	{
		name:        "evaluate",
		description: "Evaluate JavaScript in the current page (awaitPromise enabled) and return the result.",
		props: map[string]any{
			"code":  strProp("JavaScript expression or statements to evaluate."),
			"frame": strProp("Frame to run the code in (frameId or URL substring). Default: top frame."),
		},
		required: []string{"code"},
	},
	{
		name:        "network",
		description: "Capture and inspect network requests: start/stop recording, list captured requests, or fetch one request's detail (incl. body).",
		props: map[string]any{
			"cmd":       strEnumProp("Sub-command.", "start", "stop", "list", "detail"),
			"filter":    strProp("Substring filter applied to request URLs (for list)."),
			"requestId": strProp("Request ID from list output (for detail)."),
		},
		required: []string{"cmd"},
	},
	{
		name:        "mouse_click",
		description: "Click an element via coordinate-level mouse events (passes isTrusted checks, unlike click).",
		props: map[string]any{
			"selector": strProp("@eN ref (from snapshot) or CSS selector of the element to click."),
			"frame":    strProp("Frame to resolve CSS selectors in (frameId or URL substring). Ignored for @e refs — they carry their own frame."),
		},
		required: []string{"selector"},
	},
	{
		name:        "wait",
		description: "Wait until text appears, a selector is visible, or the tab URL contains a substring. Exactly one of text, selector, url.",
		props: map[string]any{
			"text":        strProp("Substring to find in visible text or AX names."),
			"selector":    strProp("@e ref or CSS selector to wait for (visible, non-zero box)."),
			"url":         strProp("Substring the current tab URL must contain."),
			"gone":        boolProp("Invert: wait until the condition is no longer true."),
			"timeout_ms":  intProp("Timeout in milliseconds (default 15000, max 120000). Must be less than the daemon tool timeout."),
			"interval_ms": intProp("Poll interval in milliseconds (default 200)."),
			"frame":       strProp("Frame to poll text/selector in (frameId or URL substring). url still matches the tab URL."),
		},
	},
	{
		name:        "scroll",
		description: "Scroll the page or an element into view. Exactly one of selector, to, direction.",
		props: map[string]any{
			"selector":  strProp("Scroll this element into the center of the viewport."),
			"to":        strEnumProp("Scroll to the top or bottom of the page.", "top", "bottom"),
			"direction": strEnumProp("Scroll one step in this direction.", "up", "down", "left", "right"),
			"amount":    map[string]any{"description": "Pixels or \"page\" (default page). Only with direction."},
		},
	},
	{
		name:        "hover",
		description: "Move the mouse over an element (CSS :hover menus). Trusted mouseMoved, no click.",
		props: map[string]any{
			"selector": strProp("@e ref or CSS selector to hover."),
			"frame":    strProp("Frame to resolve CSS selectors in (frameId or URL substring). Ignored for @e refs — they carry their own frame."),
		},
		required: []string{"selector"},
	},
	{
		name:        "key_type",
		description: "Type text into the currently focused element via Input.insertText.",
		props: map[string]any{
			"text": strProp("Text to insert."),
		},
		required: []string{"text"},
	},
	{
		name:        "send_keys",
		description: "Send key presses: Enter/Escape/Tab/F1-F12/single letters and digits, modifiers Alt/Ctrl/Cmd/Meta/Shift/Mod; space-separated for multiple chords.",
		props: map[string]any{
			"keys":   strProp("Key chord(s), e.g. \"Enter\", \"Mod+a\", \"Tab Tab Enter\"."),
			"repeat": intProp("Repeat count, 1-100."),
		},
		required: []string{"keys"},
	},
	{
		name:        "cdp",
		description: "Raw Chrome DevTools Protocol command passthrough on the current tab (escape hatch). Returns the CDP result object as-is; empty/null becomes {}; arrays and primitives are wrapped as {value}. This is the tool data inside the HTTP {success,data} envelope; the daemon does not wrap again.",
		props: map[string]any{
			"method": strProp("CDP method, e.g. \"Page.captureScreenshot\"."),
			"params": map[string]any{"type": "object", "description": "CDP method parameters."},
		},
		required: []string{"method"},
	},
	{
		name:        "screenshot",
		description: "Take a screenshot of the current page (or one element) and save it to a file; returns the file path.",
		props: map[string]any{
			"format":   strEnumProp("Image format (default png).", "png", "jpeg"),
			"quality":  intProp("JPEG quality 0-100 (jpeg only)."),
			"selector": strProp("@eN ref or CSS selector to capture only that element."),
			"fullPage": boolProp("Capture the full scrollable page. Mutually exclusive with selector."),
			"path":     strProp("Output file path, written verbatim (prefer absolute; relative is vs the daemon cwd). Default: a temp file."),
			"frame":    strProp("Frame context for selector (frameId or URL substring). With fullPage, clips to the iframe's visible box in the parent viewport."),
		},
	},
	{
		name:        "save_as_pdf",
		description: "Save the current page as a PDF file; returns the file path.",
		props: map[string]any{
			"paper_format":     strEnumProp("Paper format (default letter).", "letter", "a4", "legal", "a3", "tabloid"),
			"landscape":        boolProp("Landscape orientation."),
			"scale":            numProp("Scale factor, 0.1-2."),
			"print_background": boolProp("Include background graphics."),
			"file_name":        strProp("Output file name (default: page title)."),
			"path":             strProp("Output file path, written verbatim (prefer absolute; relative is vs the daemon cwd). Default: a temp file."),
		},
	},
	{
		name:        "upload",
		description: "Set files on a file input element.",
		props: map[string]any{
			"selector": strProp("@eN ref (from snapshot) or CSS selector of the file input."),
			"files":    strSliceProp("Local file paths to attach, passed verbatim (prefer absolute). Not restricted to ~/Downloads."),
		},
		required: []string{"selector", "files"},
	},
	{
		name:        "list_tabs",
		description: "List the tabs owned by the current session.",
		props:       map[string]any{},
	},
	{
		name:        "close_tab",
		description: "Close the session's current tab.",
		props:       map[string]any{},
	},
	{
		name:        "close_session",
		description: "Close all tabs of the session.",
		props:       map[string]any{},
	},
	{
		name:        "list_frames",
		description: "List all frames in the current tab, including cross-origin iframes (marked isolated, cannot be entered).",
		props:       map[string]any{},
	},
}
