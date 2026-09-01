package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCheckCachesResult(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		fmt.Fprint(w, `{"tag_name":"v0.8.0"}`)
	}))
	defer srv.Close()
	dir := t.TempDir()
	c := &Checker{Dir: dir, APIURL: srv.URL}
	r1, err := c.Check(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if r1.LatestVersion != "0.8.0" || r1.Tag != "v0.8.0" {
		t.Fatalf("bad result: %+v", r1)
	}
	// 第二次不 force:命中缓存,不再打 API
	if _, err := c.Check(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if hits != 1 {
		t.Fatalf("期望 1 次 API 调用,实际 %d", hits)
	}
	// force 绕过缓存
	if _, err := c.Check(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if hits != 2 {
		t.Fatalf("force 后期望 2 次,实际 %d", hits)
	}
}

func TestCheckCacheTTLExpired(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		fmt.Fprint(w, `{"tag_name":"v0.8.1"}`)
	}))
	defer srv.Close()
	dir := t.TempDir()
	// 注入 Now:缓存里写的是 25h 前,不 force 也应重新请求
	now := time.Now()
	old := now.Add(-25 * time.Hour)
	c := &Checker{Dir: dir, APIURL: srv.URL, Now: func() time.Time { return now }}
	// 预置一个过期缓存
	stale := CheckResult{LatestVersion: "0.8.0", Tag: "v0.8.0", CheckedAt: old}
	data, err := json.Marshal(stale)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, cacheFileName), data, 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := c.Check(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if hits != 1 {
		t.Fatalf("缓存过期后期望 1 次 API 调用,实际 %d", hits)
	}
	if r.LatestVersion != "0.8.1" {
		t.Fatalf("期望拿到新版本 0.8.1,实际 %s", r.LatestVersion)
	}
}

func TestCheckAPIFailWithStaleCache(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	dir := t.TempDir()
	now := time.Now()
	c := &Checker{Dir: dir, APIURL: srv.URL, Now: func() time.Time { return now }}
	// 预置过期缓存:API 挂了也应返回它,不报错
	stale := CheckResult{LatestVersion: "0.7.5", Tag: "v0.7.5", CheckedAt: now.Add(-48 * time.Hour)}
	data, err := json.Marshal(stale)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, cacheFileName), data, 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := c.Check(context.Background(), false)
	if err != nil {
		t.Fatalf("有过期缓存时不应报错: %v", err)
	}
	if r == nil || r.LatestVersion != "0.7.5" {
		t.Fatalf("期望返回过期缓存,实际 %+v", r)
	}
}

func TestCheckAPIFailNoCache(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	dir := t.TempDir()
	c := &Checker{Dir: dir, APIURL: srv.URL}
	if _, err := c.Check(context.Background(), false); err == nil {
		t.Fatal("无缓存且 API 失败时应返回 error")
	}
}

func TestNewerAvailable(t *testing.T) {
	cases := []struct {
		cur, lat string
		want     bool
	}{
		{"0.7.0", "0.8.0", true}, {"0.7.0", "0.7.0", false}, {"0.7.0", "0.6.9", false},
		{"0.7.0", "garbage", false}, {"0.7", "0.7.1", true}, {"1.0.0", "0.9.9", false},
	}
	for _, c := range cases {
		if got := NewerAvailable(c.cur, c.lat); got != c.want {
			t.Errorf("NewerAvailable(%q,%q)=%v want %v", c.cur, c.lat, got, c.want)
		}
	}
}
