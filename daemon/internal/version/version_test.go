package version

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Version 必须是 string var 而非 const，否则 release 的 -X 注入静默无效。
func TestVersionIsVar(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "version.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok {
			continue
		}
		if gd.Tok == token.CONST {
			t.Fatal("Version 不允许声明为 const(release 需要 -X ldflags 注入)")
		}
	}
}
